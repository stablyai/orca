import { ipcMain } from 'electron'
import { getLocalWorktreeCatalogVersion } from '../../../local-worktree-scan-generation'
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
import {
  finishAcceptedWorktreeRemoval,
  waitForPendingWorktreeRemoval
} from '../../../worktree-background-removal'
import { runSerializedWorktreeRemovalAcceptance } from '../../../worktree-removal-acceptance-queue'

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
      // Why: a retry or a second window asking while Git still deletes joins that removal.
      const pending = waitForPendingWorktreeRemoval(args.worktreeId, removalHostId)
      if (pending) {
        return { ...(await pending), catalogVersion: getLocalWorktreeCatalogVersion(repoId) }
      }
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
      const removal = withWorktreeSpan({ stage: 'remove', path: worktreePath }, async () => {
        const accept = async (): Promise<RemoveWorktreeResult> =>
          // Why: another client's removal of this worktree may have been accepted during the wait.
          waitForPendingWorktreeRemoval(args.worktreeId, removalHostId)
            ? { removing: true }
            : executeWorktreeRemoval(context, args, repo, repoId, worktreePath, removalHostId)
        const accepted = await (repo.connectionId
          ? accept()
          : runSerializedWorktreeRemovalAcceptance(repo.path, accept))
        const result = await finishAcceptedWorktreeRemoval(accepted, args.worktreeId, removalHostId)
        // A background job reports its own lifecycle when Git finishes.
        if (!accepted.removing) {
          options?.onWorktreeLifecycle?.({
            kind: 'removed',
            worktreeId: args.worktreeId,
            path: worktreePath
          })
        }
        // Why stamped inside the shared promise: a coalesced second caller gets the same reply,
        // naming the catalog this removal produced.
        return { ...result, catalogVersion: getLocalWorktreeCatalogVersion(repoId) }
      })
      worktreeRemovalsInFlight.set(inFlightKey, { optionsKey, promise: removal })
      try {
        return await removal
      } finally {
        if (worktreeRemovalsInFlight.get(inFlightKey)?.promise === removal) {
          worktreeRemovalsInFlight.delete(inFlightKey)
        }
      }
    }
  )
}
