import { ipcMain } from 'electron'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import {
  localWatchResultFor,
  subscribeLocalWatcher,
  unsubscribeLocalWatcher
} from './filesystem-watcher-local-subscription'
import type { WatchWorktreeResult } from '../../../../shared/file-watch/watch-worktree-result'

export function registerFilesystemWatcherHandlers(): void {
  ipcMain.handle(
    'fs:watchWorktree',
    async (
      event,
      args: { worktreePath: string; connectionId?: string }
    ): Promise<WatchWorktreeResult | undefined> => {
      // Remote workspaces watch through runtime streams; local IPC has no SSH filesystem transport.
      if (args.connectionId) {
        return undefined
      }
      // Reopen for post-shutdown attachment; older callers retain the retired generation.
      watcherLifecycleState.localWatchersClosed = false
      await subscribeLocalWatcher(args.worktreePath, event.sender)
      // Why: an unwatchable or capacity-deferred root resolves the same way, so callers that hand off coverage need the outcome.
      return localWatchResultFor(args.worktreePath, event.sender.id)
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
