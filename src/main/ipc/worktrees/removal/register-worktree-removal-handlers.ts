import { ipcMain } from 'electron'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { withWorktreeSpan } from '../../../observability/instrumentation'
import { parseWorktreeId } from '../../worktree-logic'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { executeWorktreeRemoval } from './execute-worktree-removal'
import {
  getWorktreeRemovalInFlightKey,
  getWorktreeRemovalOptionsKey
} from './worktree-removal-coordinator'
import { resolveRepoForExecutionHost } from '../repo-host-ownership'

export function registerWorktreeRemovalHandlers(context: WorktreeIpcContext): void {
  const { store, options, worktreeRemovalsInFlight } = context

  ipcMain.handle(
    'worktrees:remove',
    async (_event, args: RemoveWorktreeArgs): Promise<RemoveWorktreeResult> => {
      const { repoId, worktreePath } = parseWorktreeId(args.worktreeId)
      const repo = resolveRepoForExecutionHost(store, repoId, args.hostId)
      if (!repo) {
        throw new Error(`Repo not found: ${repoId}`)
      }
      // The resolved repo supplies host ownership when legacy callers omit args.hostId.
      const removalHostId = getRepoExecutionHostId(repo)
      const inFlightKey = getWorktreeRemovalInFlightKey(args.worktreeId, removalHostId)
      const optionsKey = getWorktreeRemovalOptionsKey(args)
      const inFlightRemoval = worktreeRemovalsInFlight.get(inFlightKey)
      if (inFlightRemoval) {
        if (inFlightRemoval.optionsKey === optionsKey) {
          return inFlightRemoval.promise
        }
        throw new Error(`Worktree deletion already in progress: ${args.worktreeId}`)
      }

      // Why: concurrent stale-toast/double-click/sidebar races can hit the same worktree; share the op so only one path touches Git and disk.
      const removal = withWorktreeSpan({ stage: 'remove', path: worktreePath }, () =>
        executeWorktreeRemoval(context, args, repo, repoId, worktreePath, removalHostId)
      )
      worktreeRemovalsInFlight.set(inFlightKey, { optionsKey, promise: removal })
      try {
        const result = await removal
        options?.onWorktreeLifecycle?.({
          kind: 'removed',
          worktreeId: args.worktreeId,
          path: parseWorktreeId(args.worktreeId).worktreePath
        })
        return result
      } finally {
        if (worktreeRemovalsInFlight.get(inFlightKey)?.promise === removal) {
          worktreeRemovalsInFlight.delete(inFlightKey)
        }
      }
    }
  )
}
