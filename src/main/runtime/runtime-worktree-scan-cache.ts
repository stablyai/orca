import type { Repo } from '../../shared/repo-types'
import { isAgentScratchRepoRootPath } from '../../shared/agent-scratch-worktrees'
import {
  getRepoExecutionHostId,
  getRepoRoutingConnectionId,
  getRepoSshConnectionId
} from '../../shared/execution-host'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { RuntimeWorktreeScanCache } from './orca-runtime-core'

const WORKTREE_SCAN_CACHE_TTL_MS = 30_000
const WORKTREE_SCAN_AGENT_SCRATCH_TTL_MS = 5 * 60_000

export function resolveWorktreeScanCacheTtlMs(
  repo: Pick<Repo, 'path' | 'connectionId' | 'executionHostId'>
): number {
  return !getRepoRoutingConnectionId(repo) && isAgentScratchRepoRootPath(repo.path)
    ? WORKTREE_SCAN_AGENT_SCRATCH_TTL_MS
    : WORKTREE_SCAN_CACHE_TTL_MS
}

/** The cache scope, runtime and generation a listing of `repo` must match to be current. */
export function worktreeScanScope(
  repo: Repo,
  generations: ReadonlyMap<string, number>,
  resolveRuntime: () => ProjectExecutionRuntimeResolution | undefined,
  projectRuntimeByRepoId?: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
) {
  // Resolve executionHostId-only SSH rows too; local routing would miskey caches and miss provider replacements.
  const sshConnectionId = getRepoSshConnectionId(repo)
  const projectRuntime = projectRuntimeByRepoId
    ? projectRuntimeByRepoId.get(repo.id)
    : !sshConnectionId
      ? resolveRuntime()
      : undefined
  const runtimeKey = projectRuntime
    ? projectRuntime.status === 'resolved'
      ? projectRuntime.runtime.cacheKey
      : projectRuntime.repair.cacheKey
    : sshConnectionId
      ? `ssh:${sshConnectionId}`
      : 'local:default'
  const scanScopeKey = `${repo.id}\0${getRepoExecutionHostId(repo)}`
  const generation = generations.get(scanScopeKey) ?? 0
  const fresh = (cached: RuntimeWorktreeScanCache, now: number): boolean =>
    cached.generation === generation && cached.runtimeKey === runtimeKey && cached.expiresAt > now
  return { sshConnectionId, projectRuntime, runtimeKey, scanScopeKey, generation, fresh }
}
