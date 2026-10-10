import { getWorktreeWatcherRemoval } from '../ipc/worktree-watcher-removal'
import { acquireWatcherRemovalGate } from '../ipc/watcher-removal-gate'
import {
  createWatcherRemovalDeadline,
  drainBeforeWatcherRemoval,
  type WatcherRemovalDeadline
} from '../ipc/watcher-removal-drain'

type FileExplorerWatcherCommands = {
  closeFileExplorerWatchersForPath(worktreePath: string, connectionId?: string): Promise<void>
  restoreFileExplorerWatchersAfterFailedRemoval(
    worktreePath: string,
    connectionId?: string
  ): Promise<void>
  forgetFileExplorerWatchersAfterRemoval(worktreePath: string, connectionId?: string): void
}

export function createRuntimeFileWatcherRemoval(fileCommands: FileExplorerWatcherCommands) {
  const close = async (
    worktreePath: string,
    connectionId?: string,
    deadline: WatcherRemovalDeadline = createWatcherRemovalDeadline()
  ): Promise<void> => {
    const results = await Promise.allSettled([
      connectionId
        ? drainBeforeWatcherRemoval(
            getWorktreeWatcherRemoval().closeRemote(connectionId, worktreePath),
            deadline,
            `remote watcher close for ${worktreePath}`
          )
        : getWorktreeWatcherRemoval().closeLocal(worktreePath, deadline),
      drainBeforeWatcherRemoval(
        fileCommands.closeFileExplorerWatchersForPath(worktreePath, connectionId),
        deadline,
        `file explorer watcher close for ${worktreePath}`
      )
    ])
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (failure) {
      // Why: restoration must wait until every bounded teardown settles.
      throw failure.reason
    }
  }

  const restore = async (worktreePath: string, connectionId?: string): Promise<void> => {
    await Promise.all([
      connectionId
        ? getWorktreeWatcherRemoval().restoreRemote(connectionId, worktreePath)
        : getWorktreeWatcherRemoval().restoreLocal(worktreePath),
      fileCommands.restoreFileExplorerWatchersAfterFailedRemoval(worktreePath, connectionId)
    ])
  }

  const forget = (worktreePath: string, connectionId?: string): void => {
    if (connectionId) {
      getWorktreeWatcherRemoval().forgetRemote(connectionId, worktreePath)
    } else {
      getWorktreeWatcherRemoval().forgetLocal(worktreePath)
    }
    fileCommands.forgetFileExplorerWatchersAfterRemoval(worktreePath, connectionId)
  }

  const acquire = async (
    worktreePath: string,
    connectionId?: string
  ): Promise<{ finish(removed: boolean): Promise<void> }> => {
    const gate = acquireWatcherRemovalGate(worktreePath, connectionId)
    const deadline = createWatcherRemovalDeadline()
    try {
      await close(worktreePath, connectionId, deadline)
      const fenceDrain = await drainBeforeWatcherRemoval(
        gate.ready,
        deadline,
        `watcher install fence for ${worktreePath}`
      )
      if (fenceDrain === 'timeout') {
        gate.abandonPendingInstalls()
      }
      await close(worktreePath, connectionId, deadline)
      let finished = false
      return {
        finish: async (removed) => {
          if (finished) {
            return
          }
          finished = true
          if (removed) {
            forget(worktreePath, connectionId)
          }
          gate.release()
          if (!removed) {
            await restore(worktreePath, connectionId).catch((restoreError: unknown) => {
              console.error('[worktrees] failed to restore watchers after removal failed', {
                worktreePath,
                restoreError
              })
            })
          }
        }
      }
    } catch (error) {
      gate.release()
      await restore(worktreePath, connectionId).catch((restoreError: unknown) => {
        console.error('[worktrees] failed to restore watchers after removal setup failed', {
          worktreePath,
          restoreError
        })
      })
      throw error
    }
  }

  return { close, restore, forget, acquire }
}
