import { ipcMain } from 'electron'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import {
  subscribeLocalWatcher,
  unsubscribeLocalWatcher
} from './filesystem-watcher-local-subscription'

export function registerFilesystemWatcherHandlers(): void {
  ipcMain.handle(
    'fs:watchWorktree',
    async (event, args: { worktreePath: string; connectionId?: string }): Promise<void> => {
      // Remote workspaces watch through runtime streams; local IPC has no SSH filesystem transport.
      if (args.connectionId) {
        return
      }
      // Reopen for post-shutdown attachment; older callers retain the retired generation.
      watcherLifecycleState.localWatchersClosed = false
      await subscribeLocalWatcher(args.worktreePath, event.sender)
    }
  )

  ipcMain.handle(
    'fs:unwatchWorktree',
    (event, args: { worktreePath: string; connectionId?: string }): void => {
      if (args.connectionId) {
        return
      }
      unsubscribeLocalWatcher(args.worktreePath, event.sender.id)
    }
  )
}
