const SYNC_DEBUG = true;

const sync = {
  storageArea: {
    area: browser.storage.sync,

    async get(){
      return await this.area.get();
    },

    async set(options) {
      return await this.area.set(options);
    },

    async getStoredArray(objectKey) {
      const storedArray = await this.getStoredItem(objectKey);
      return (storedArray) ?  storedArray : [];
    },

    async getStoredObject(objectKey) {
      const storedObject = await this.getStoredItem(objectKey);
      return (storedObject) ?  storedObject : {};
    },

    async getStoredItem(objectKey) {
      const outputObject = await this.get(objectKey);
      if (outputObject && outputObject[objectKey]) 
        return outputObject[objectKey];
      if (SYNC_DEBUG) 
        console.warn(objectKey, " was requested and is not available.");
      return false;
    },

    async hasSyncStorage(){
      const inSync = await this.get();
      return !(Object.entries(inSync).length === 0);
    },

    async backup(options) {
      if (SYNC_DEBUG) console.log("backup");
      // remove listeners to avoid an infinite loop!
      await browser.storage.onChanged.removeListener(
        sync.storageArea.onChangedListener);

      await removeContextualIdentityListeners();

      await updateSyncIdentities();
      await updateCookieStoreIdMap();
      await updateSyncSiteAssignments();
      if (options && options.uuid) 
        await updateDeletedIdentityList(options.uuid);
      if (options && options.siteStoreKey) 
        await addToDeletedSitesList(options.siteStoreKey);
      if (options && options.undelete) 
        await removeFromDeletedSitesList(options.undelete);
      if (SYNC_DEBUG) {
        const storage = await sync.storageArea.get();
        console.log("in sync: ", storage);
        const localStorage = await browser.storage.local.get();
        console.log("inLocal:", localStorage);
      }
      browser.storage.onChanged.addListener(
        sync.storageArea.onChangedListener);
      addContextualIdentityListeners();

      async function updateSyncIdentities() {
        const identities = await browser.contextualIdentities.query({});
        await sync.storageArea.set({ identities });
      }

      async function updateCookieStoreIdMap() {
        const cookieStoreIDmap = 
          await identityState.getCookieStoreIDuuidMap();
        await sync.storageArea.set({ cookieStoreIDmap });
      }

      async function updateSyncSiteAssignments() {
        const assignedSites = 
          await assignManager.storageArea.getAssignedSites();
        await sync.storageArea.set({ assignedSites });
      }

      async function updateDeletedIdentityList(deletedIdentityUUID) {
        let { deletedIdentityList } = 
          await sync.storageArea.get("deletedIdentityList");
        if (!deletedIdentityList) deletedIdentityList = [];
        if (
          deletedIdentityList.find(element => element === deletedIdentityUUID)
        ) return;
        deletedIdentityList.push(deletedIdentityUUID);
        await sync.storageArea.set({ deletedIdentityList });
      }

      async function addToDeletedSitesList(siteStoreKey) {
        let { deletedSiteList } = 
          await sync.storageArea.get("deletedSiteList");
        if (!deletedSiteList) deletedSiteList = [];
        if (deletedSiteList.find(element => element === siteStoreKey)) return;
        deletedSiteList.push(siteStoreKey);
        await sync.storageArea.set({ deletedSiteList });
      }

      async function removeFromDeletedSitesList(siteStoreKey) {
        let { deletedSiteList } = 
          await sync.storageArea.get("deletedSiteList");
        if (!deletedSiteList) return;
        deletedSiteList = deletedSiteList
          .filter(element => element !== siteStoreKey);
        await sync.storageArea.set({ deletedSiteList });
      }
    },

    /*
     * Ensures all sync info matches. But maybe we shouldn't even use
     * sync info that doesn't match.
     */
    async cleanup() {
      console.log("cleanupSync");
      browser.storage.onChanged.removeListener(
        sync.storageArea.onChangedListener);
      const identitiesList = 
        await sync.storageArea.getStoredObject("identities");
      const cookieStoreIDmap = 
        await sync.storageArea.getStoredObject("cookieStoreIDmap");
      for(const cookieStoreId of Object.keys(cookieStoreIDmap)) {
        const match = identitiesList
          .find(syncIdentity => 
            syncIdentity.cookieStoreId === cookieStoreId
          );
        if (!match) {
          delete cookieStoreIDmap[cookieStoreId];
          await sync.storageArea.set({ cookieStoreIDmap });
          console.log("removed ", cookieStoreId, " from sync list");
        }
      }
      await browser.storage.onChanged.addListener(
        sync.storageArea.onChangedListener);
    },

    onChangedListener(changes, areaName) {
      if (areaName === "sync") runSync();
    },

    async addToDeletedList(changeInfo) {
      const identity = changeInfo.contextualIdentity;
      console.log("addToDeletedList", identity.cookieStoreId);
      const deletedUUID = 
        await identityState.lookupMACaddonUUID(identity.cookieStoreId);
      await identityState.storageArea.remove(identity.cookieStoreId);
      console.log(deletedUUID);
      sync.storageArea.backup({uuid: deletedUUID});
    }
  },

  init() {
    const errorHandledInitSync = () => {
      this.initSync().catch((error)=> { 
        console.error("Error from initSync", error);
      });
    };
    browser.runtime.onInstalled.addListener(errorHandledInitSync);
    browser.runtime.onStartup.addListener(errorHandledInitSync);
  },

  async initSync() {
    const syncInfo = await sync.storageArea.get();
    const localInfo = await browser.storage.local.get();
    if (SYNC_DEBUG) {
      console.log("inSync: ", syncInfo);
      console.log("inLocal: ", localInfo);
    }
    const beenSynced = await assignManager.storageArea.getSynced();
    if (beenSynced){
      await runSync();
      return;
    }
    await runFirstSync();
  },
};

sync.init();


async function runSync() {
  browser.storage.onChanged.removeListener(
    sync.storageArea.onChangedListener);
  removeContextualIdentityListeners();
  console.log("runSync");
  await identityState.storageArea.cleanup();


  if (await sync.storageArea.hasSyncStorage()){
    await sync.storageArea.cleanup();
    console.log("storage found, attempting to restore ...");
    await restore();
    return;
  }
  console.log("no sync storage, backing up...");
  await sync.storageArea.backup();
  return;
}

async function restore() {
  console.log("restore");
  await reconcileIdentitiesByUUID();
  await reconcileSiteAssignments();
  await sync.storageArea.backup();
}

async function runFirstSync() {
  console.log("runFirstSync");
  // looks for abandoned identities keys in local storage, and identities
  // not in localstorage (which also adds a uuid)
  await identityState.storageArea.cleanup();

  if (await sync.storageArea.hasSyncStorage()){
    await sync.storageArea.cleanup();
    console.log("storage found, attempting to restore ...");
    await restoreFirstRun();
  }else {
    console.log("no sync storage, backing up...");
    await sync.storageArea.backup();
  }
  await assignManager.storageArea.setSynced();
}

async function restoreFirstRun() {
  console.log("restoreFirstRun");
  await reconcileIdentities();
  await reconcileSiteAssignments();
  await sync.storageArea.backup();
}

/*
 * Checks for the container name. If it exists, they are assumed to be the
 * same container, and the color and icon are overwritten from sync, if
 * different.
 */
async function reconcileIdentities(){
  console.log("reconcileIdentities");

  // first delete any from the deleted list
  const deletedIdentityList =
    await sync.storageArea.getStoredArray("deletedIdentityList");
  // first remove any deleted identities
  for (const deletedUUID of deletedIdentityList) {
    const deletedCookieStoreId = 
      await identityState.lookupCookieStoreId(deletedUUID);
    if (deletedCookieStoreId){
      await browser.contextualIdentities.remove(deletedCookieStoreId);
    }
  }
  
  const localIdentities = await browser.contextualIdentities.query({});
  const syncIdentities = 
    await sync.storageArea.getStoredObject("identities");
  const cookieStoreIDmap = 
    await sync.storageArea.getStoredObject("cookieStoreIDmap");
  for (const syncIdentity of syncIdentities) {
    syncIdentity.macAddonUUID = cookieStoreIDmap[syncIdentity.cookieStoreId];
    const match = localIdentities.find(
      localIdentity => localIdentity.name === syncIdentity.name
    );
    if (!match) {
      console.log("create new ident: ", syncIdentity.name);
      const newIdentity = 
        await browser.contextualIdentities.create({
          name: syncIdentity.name, 
          color: syncIdentity.color, 
          icon: syncIdentity.icon
        });
      await identityState.updateUUID(
        newIdentity.cookieStoreId, 
        syncIdentity.macAddonUUID
      );
      continue;
    }
    if (syncIdentity.color !== match.color 
      || syncIdentity.icon !== match.icon) {
      await browser.contextualIdentities.update(
        match.cookieStoreId, {
          name: syncIdentity.name, 
          color: syncIdentity.color, 
          icon: syncIdentity.icon
        });
      continue;
    }
    if (SYNC_DEBUG) {
      if (match.color !== syncIdentity.color) {
        console.log(match.name, "Change color: ", syncIdentity.color);
      }
      if (match.icon !== syncIdentity.icon) {
        console.log(match.name, "Change icon: ", syncIdentity.icon);
      }
    }
    // end testing
    await identityState.updateUUID(
      match.cookieStoreId, 
      cookieStoreIDmap[syncIdentity.cookieStoreId]
    );
  }
}

/*
 * Checks for site previously assigned. If it exists, and has the same
 * container assignment, the assignment is kept. If it exists, but has
 * a different assignment, the user is prompted (not yet implemented).
 * If it does not exist, it is created.
 */
async function reconcileSiteAssignments() {
  console.log("reconcileSiteAssignments");
  const assignedSitesLocal = 
    await assignManager.storageArea.getAssignedSites();
  const assignedSitesFromSync = 
    await sync.storageArea.getStoredObject("assignedSites");
  const deletedSiteList = 
    await sync.storageArea.getStoredArray("deletedSiteList");
  for(const siteStoreKey of deletedSiteList) {
    if (assignedSitesLocal.hasOwnProperty(siteStoreKey)) {
      assignManager
        .storageArea
        .remove(siteStoreKey.replace(/^siteContainerMap@@_/, "https://"));
    }
  }
  const cookieStoreIDmap =
    await sync.storageArea.getStoredObject("cookieStoreIDmap");

  for(const urlKey of Object.keys(assignedSitesFromSync)) {
    const assignedSite = assignedSitesFromSync[urlKey];
    const syncUUID = 
      await lookupSyncSiteAssigmentIdentityUUID(
        assignedSite, cookieStoreIDmap, urlKey
      );
    if (syncUUID) {
      // Sync is truth.
      // Not even looking it up. Just overwrite
      console.log("new assignment ", assignedSite, ": ", 
        assignedSite.userContextId);
      const newUUID = cookieStoreIDmap[
        "firefox-container-" + assignedSite.userContextId
      ];
      await setAssignmentWithUUID(newUUID, assignedSite, urlKey);
      continue;
    }

    // if there's no syncUUID, something is wrong, since these site
    // assignments are from sync
    throw new Error("Sync storage not aligned");
  }

  async function lookupSyncSiteAssigmentIdentityUUID(
    assignedSite,
    cookieStoreIDmap,
  ){
    const syncCookieStoreId = 
      "firefox-container-" + assignedSite.userContextId;
    return cookieStoreIDmap[syncCookieStoreId];
  }
}

async function setAssignmentWithUUID (newUUID, assignedSite, urlKey) {
  const cookieStoreId = await identityState.lookupCookieStoreId(newUUID);
  if (cookieStoreId) {
    assignedSite.userContextId = cookieStoreId
      .replace(/^firefox-container-/, "");
    await assignManager.storageArea.set(
      urlKey.replace(/^siteContainerMap@@_/, "https://"),
      assignedSite
    );
    return;
  }
  throw new Error (`No cookieStoreId found for: ${newUUID}, ${urlKey}`);
}

/*
 * Matches uuids in sync to uuids locally, and updates containers accordingly.
 * If there is no match, it creates the new container.
 */
async function reconcileIdentitiesByUUID() {
  console.log("reconcileIdentitiesByUUID");
  const syncIdentities = await sync.storageArea.getStoredObject("identities");
  const cookieStoreIDmap = 
    await sync.storageArea.getStoredObject("cookieStoreIDmap");
    
  const deletedIdentityList =
    await sync.storageArea.getStoredArray("deletedIdentityList");
  // first remove any deleted identities
  for (const deletedUUID of deletedIdentityList) {
    const deletedCookieStoreId = 
      await identityState.lookupCookieStoreId(deletedUUID);
    if (deletedCookieStoreId){
      await browser.contextualIdentities.remove(deletedCookieStoreId);
    }
  }

  // Lookup all identities in teh cookieStoreIDmap and make sure they
  // exist locally
  for (const syncCookieStoreID of Object.keys(cookieStoreIDmap)) {
    const syncUUID = cookieStoreIDmap[syncCookieStoreID];
    //find localCookiesStoreID by looking up the syncUUID
    const localCookieStoreID = 
      await identityState.lookupCookieStoreId(syncUUID);
    // get correct indentity info from sync
    const identityInfo = 
      findIdentityFromSync(syncCookieStoreID, syncIdentities);
    if (localCookieStoreID) {
      if (SYNC_DEBUG) {
        const getIdent = 
          await browser.contextualIdentities.get(localCookieStoreID);
        if (getIdent.name !== identityInfo.name) {
          console.log(getIdent.name, "Change name: ", identityInfo.name);
        }
        if (getIdent.color !== identityInfo.color) {
          console.log(getIdent.name, "Change color: ", identityInfo.color);
        }
        if (getIdent.icon !== identityInfo.icon) {
          console.log(getIdent.name, "Change icon: ", identityInfo.icon);
        }
      }

      // update the local container with the sync data
      await browser.contextualIdentities
        .update(localCookieStoreID, identityInfo);
      continue;
    }
    //not found, create new with same UUID
    console.log("new Identity: ", identityInfo.name);
    const newIdentity = 
      await browser.contextualIdentities.create(identityInfo);
    await identityState.updateUUID(newIdentity.cookieStoreId, syncUUID);
  }
  return;
}

function findIdentityFromSync(cookieStoreId, identitiesList){
  for (const identity of identitiesList) {
    const { name, color, icon } = identity;
    if (identity.cookieStoreId === cookieStoreId) 
      return { name, color, icon };
  }
}

const syncCIListenerList = [
  sync.storageArea.backup, 
  sync.storageArea.addToDeletedList, 
  sync.storageArea.backup
];

function addContextualIdentityListeners(listenerList) {
  if(!listenerList) listenerList = syncCIListenerList;
  browser.contextualIdentities.onCreated.addListener(listenerList[0]);
  browser.contextualIdentities.onRemoved.addListener(listenerList[1]);
  browser.contextualIdentities.onUpdated.addListener(listenerList[2]);
}

function removeContextualIdentityListeners(listenerList) {
  if(!listenerList) listenerList = syncCIListenerList;
  browser.contextualIdentities.onCreated.removeListener(listenerList[0]);
  browser.contextualIdentities.onRemoved.removeListener(listenerList[1]);
  browser.contextualIdentities.onUpdated.removeListener(listenerList[2]);
}