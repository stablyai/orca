import type { BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import { onSshFilesystemProviderGenerationChanged } from '../providers/ssh-filesystem-dispatch'
import {
  WorktreeBaseDirectoryWatcherSyncQueue,
  type PendingWorktreeBaseDirectoryWatcherSync,
  type WorktreeBaseDirectoryWatcherSyncRequest
} from './worktree-base-directory-watcher-sync-queue'

export type WorktreeBaseDirectoryWatcherSync = {
  sync: (
    store: Store,
    mainWindow: BrowserWindow,
    request?: WorktreeBaseDirectoryWatcherSyncRequest
  ) => Promise<void>
  setContext: (store: Store, mainWindow: BrowserWindow) => void
  schedule: (
    store: Store,
    mainWindow: BrowserWindow,
    request?: WorktreeBaseDirectoryWatcherSyncRequest
  ) => void
  scheduleCurrent: (request?: WorktreeBaseDirectoryWatcherSyncRequest) => void
  dispose: () => Promise<void>
}

export function createWorktreeBaseDirectoryWatcherSync(
  runPass: (request: PendingWorktreeBaseDirectoryWatcherSync, signal: AbortSignal) => Promise<void>
): WorktreeBaseDirectoryWatcherSync {
  const queue = new WorktreeBaseDirectoryWatcherSyncQueue(runPass)
  let latestContext: { mainWindow: BrowserWindow; store: Store } | null = null
  let unsubscribeFromProviderGenerationChanges: (() => void) | null = null

  const scheduleCurrent = (request?: WorktreeBaseDirectoryWatcherSyncRequest): void => {
    if (!latestContext || latestContext.mainWindow.isDestroyed()) {
      return
    }
    queue.schedule(latestContext.store, latestContext.mainWindow, request)
  }

  return {
    sync: (store, mainWindow, request) => queue.sync(store, mainWindow, request),
    setContext: (store, mainWindow) => {
      latestContext = { store, mainWindow }
      unsubscribeFromProviderGenerationChanges ??= onSshFilesystemProviderGenerationChanged(
        (connectionId) => scheduleCurrent({ dirtyConnectionIds: [connectionId] })
      )
      // Why: lean BrowserWindow test doubles omit once; real windows clear stale chrome authority.
      if (typeof mainWindow.once === 'function') {
        mainWindow.once('closed', () => {
          if (latestContext?.mainWindow === mainWindow) {
            latestContext = null
          }
        })
      }
    },
    schedule: (store, mainWindow, request) => queue.schedule(store, mainWindow, request),
    scheduleCurrent,
    dispose: async () => {
      latestContext = null
      unsubscribeFromProviderGenerationChanges?.()
      unsubscribeFromProviderGenerationChanges = null
      await queue.dispose()
    }
  }
}

export type { WorktreeBaseDirectoryWatcherSyncRequest }
