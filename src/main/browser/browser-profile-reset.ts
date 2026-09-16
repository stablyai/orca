import { webContents } from 'electron'
import type { Session, WebContents } from 'electron'

import { withCookieMutationLock } from './browser-cookie-import-clear'

export type BrowserProfileResetDependencies = {
  targetSession: Session
  partition: string
  clearPendingCookieImport: (partition: string) => void
  clearImportedSource: () => void
}

// Electron's global list includes popups and offscreen guests omitted by Orca's tab registry.
export function findPartitionWebContents(targetSession: Session): WebContents[] {
  return webContents
    .getAllWebContents()
    .filter((contents) => !contents.isDestroyed() && contents.session === targetSession)
}

function reloadPartitionContexts(targetSession: Session): void {
  for (const contents of findPartitionWebContents(targetSession)) {
    try {
      contents.reload()
    } catch {
      // A context that dies between enumeration and reload needs no reload.
    }
  }
}

/** Resets one session partition while serializing against cookie import mutations. */
export async function resetBrowserProfilePartition(
  deps: BrowserProfileResetDependencies
): Promise<void> {
  const { targetSession, partition, clearPendingCookieImport, clearImportedSource } = deps
  await withCookieMutationLock(targetSession, async () => {
    // Clear metadata first so a partial reset never advertises an import whose data may be gone.
    clearImportedSource()
    clearPendingCookieImport(partition)
    try {
      // Electron only rotates its persisted media-device ID salt on a cookie storage clear.
      await targetSession.clearStorageData({ storages: ['cookies'] })
      // BrowsingDataRemover additionally reaches trust tokens, bounce tracking, and network history.
      await targetSession.clearData()
    } finally {
      // A rejected removal can still leave the partition partially cleared.
      reloadPartitionContexts(targetSession)
    }
  })
}
