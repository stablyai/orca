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
      // Why: an SSH path names a remote file; the desktop has no SSH filesystem transport, and
      // managed-server workspaces watch through the runtime stream instead of this channel.
      if (args.connectionId) {
        return
      }
      // Why: reopen the local subsystem for tests and post-shutdown reattachment; stale callers keep the prior generation.
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
