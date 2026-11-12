import { BrowserExtensionProfileDocumentStore } from './browser-extension-profile-document-store'
import { app } from 'electron'
import { getBrowserExtensionProfileDataDirectory } from './browser-extension-profile-data-directory'

let syncStorageStore: BrowserExtensionProfileDocumentStore | null = null

/**
 * chrome.storage.sync items per browser profile and extension, kept on this machine the way
 * Chrome keeps them for a user who is not signed in. One file per extension, so a write rewrites
 * only that extension's items (up to 100 KB).
 */
export function getBrowserExtensionSyncStorageStore(): BrowserExtensionProfileDocumentStore {
  if (!syncStorageStore) {
    const store = new BrowserExtensionProfileDocumentStore(
      getBrowserExtensionProfileDataDirectory()
    )
    app.on('will-quit', () => store.flush())
    syncStorageStore = store
  }
  return syncStorageStore
}
