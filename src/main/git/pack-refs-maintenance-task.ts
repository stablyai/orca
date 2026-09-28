import { countLooseRefs } from '../../shared/loose-ref-count'
import {
  LOOSE_REF_PACK_THRESHOLD,
  PACK_REFS_ARGS,
  PACK_REFS_TIMEOUT_MS,
  RepoMaintenanceRepoLocked,
  type PackedRefsLockReporter,
  type RepoMaintenanceBacklog,
  type RepoMaintenancePackReport,
  type RepoMaintenanceTask
} from '../../shared/repo-maintenance-policy'
import {
  gitCommonDirForMainProcess,
  refsDirectoryForMainProcess,
  type RepoCommonDirResolver
} from './git-common-dir-paths'
import { PackRefsLockOwnership } from './pack-refs-lock-ownership'
import { gitExecFileAsync } from './runner'

/**
 * The loose-ref half of idle repo maintenance: fold `refs/**` into
 * `packed-refs` so ref enumeration stops paying for a backlog Orca's own
 * auto-maintenance-free fetches created.
 */

export type MaintenanceTaskArgs = {
  readonly repoPath: string
  readonly wslDistro?: string
  readonly resolveCommonDir: RepoCommonDirResolver
  /** Test seam only; production uses the policy threshold. */
  readonly threshold?: number
}

export function createPackRefsMaintenanceTask(args: MaintenanceTaskArgs): RepoMaintenanceTask {
  const gitOptions = args.wslDistro ? { wslDistro: args.wslDistro } : {}
  return {
    id: 'refs',
    threshold: args.threshold ?? LOOSE_REF_PACK_THRESHOLD,
    async probeBacklog(
      budget: number,
      signal: AbortSignal
    ): Promise<RepoMaintenanceBacklog | undefined> {
      const commonDir = await args.resolveCommonDir(signal)
      if (!commonDir) {
        return undefined
      }
      return countLooseRefs(refsDirectoryForMainProcess(commonDir, args.wslDistro), budget, signal)
    },
    async pack(lock: PackedRefsLockReporter): Promise<RepoMaintenancePackReport> {
      const commonDir = await args.resolveCommonDir()
      const owner = commonDir
        ? new PackRefsLockOwnership(gitCommonDirForMainProcess(commonDir, args.wslDistro))
        : null
      const claim = owner ? await owner.claim() : { ok: true as const }
      if (!claim.ok) {
        throw new RepoMaintenanceRepoLocked(claim.reason)
      }
      // Report the rewrite window rather than accepting a signal. A pack that is
      // killed mid-prune strands a `refs/**` lock about one time in five, and
      // Git never clears those; waiting out the window costs at most ~1.4s.
      const watch = owner?.watchLock((held) => lock.setHeld(held))
      try {
        await gitExecFileAsync([...PACK_REFS_ARGS], {
          cwd: args.repoPath,
          ...gitOptions,
          admissionTier: 'background',
          timeout: PACK_REFS_TIMEOUT_MS
        })
      } finally {
        watch?.stop()
        lock.setHeld(false)
        await owner?.release()
      }
      // `pack-refs --all --prune` has no batch: it either drained the backlog or
      // it did not, and a survivor is a failure rather than a remainder.
      return { batchExhausted: false }
    }
  }
}
