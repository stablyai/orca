import { registerAppHandler, appDocumentFor } from '../../app-registry/app-handler-registry'

import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import {
  subscribeLocalWatcher,
  unsubscribeLocalWatcher
} from './filesystem-watcher-local-subscription'

export function registerFilesystemWatcherHandlers(): void {
  registerAppHandler(
    'fs:watchWorktree',
    async (event, args: { worktreePath: string; connectionId?: string }): Promise<void> => {
      // Remote workspaces watch through runtime streams; local IPC has no SSH filesystem transport.
      if (args.connectionId) {
        return
      }
      // Reopen for post-shutdown attachment; older callers retain the retired generation.
      watcherLifecycleState.localWatchersClosed = false
      await subscribeLocalWatcher(args.worktreePath, appDocumentFor(event))
    }
  )

  registerAppHandler(
    'fs:unwatchWorktree',
    (event, args: { worktreePath: string; connectionId?: string }): void => {
      if (args.connectionId) {
        return
      }
      unsubscribeLocalWatcher(args.worktreePath, appDocumentFor(event).id)
    }
  )
}
