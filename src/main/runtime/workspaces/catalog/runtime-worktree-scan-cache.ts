import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { Repo } from '../../../../shared/repo-types'
import { isAgentScratchRepoRootPath } from '../../../../shared/agent-scratch-worktrees'
import {
  getRepoExecutionHostId,
  getRepoRoutingConnectionId,
  getRepoSshConnectionId
} from '../../../../shared/execution-host'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/execution-host/project-execution-runtime'
import {
  resolveLocalProjectRuntimeForRepo,
  type ProjectRuntimeResolutionStore
} from '../../../workspaces/execution-host/local-project-runtime-resolution'

import type { RuntimeWorktreeScanCache } from './runtime-worktree-scan-state'
import { WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS } from './worktree-scan-admin-budget'

const WORKTREE_SCAN_CACHE_TTL_MS = 30_000
const WORKTREE_SCAN_AGENT_SCRATCH_TTL_MS = 5 * 60_000

export function resolveWorktreeScanRuntime(
  store: ProjectRuntimeResolutionStore,
  repo: Repo,
  projectRuntimeByRepoId?: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
) {
  const sshConnectionId = getRepoSshConnectionId(repo)
  const projectRuntime = projectRuntimeByRepoId
    ? projectRuntimeByRepoId.get(repo.id)
    : !sshConnectionId
      ? resolveLocalProjectRuntimeForRepo(store, repo)
      : undefined
  const runtimeKey = projectRuntime
    ? projectRuntime.status === 'resolved'
      ? projectRuntime.runtime.cacheKey
      : projectRuntime.repair.cacheKey
    : sshConnectionId
      ? `ssh:${sshConnectionId}`
      : 'local:default'
  return { projectRuntime, runtimeKey, sshConnectionId }
}

export function resolveWorktreeScanCacheTtlMs(
  repo: Pick<Repo, 'path' | 'connectionId' | 'executionHostId'>
): number {
  return !getRepoRoutingConnectionId(repo) && isAgentScratchRepoRootPath(repo.path)
    ? WORKTREE_SCAN_AGENT_SCRATCH_TTL_MS
    : WORKTREE_SCAN_CACHE_TTL_MS
}

/** Launch proof only: reading a miss must not start or join catalog refresh work. */
export function readFreshWorktreeScan(
  store: ProjectRuntimeResolutionStore,
  repo: Repo,
  cached: RuntimeWorktreeScanCache | undefined,
  generation: number
) {
  return cached?.result.ok &&
    cached.generation === generation &&
    cached.runtimeKey === resolveWorktreeScanRuntime(store, repo).runtimeKey &&
    cached.expiresAt > Date.now() &&
    cached.scannedAt + WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS > Date.now()
    ? cached.result.worktrees
    : undefined
}

export function pruneUnregisteredWorktreeScans(
  store: Pick<RuntimeStore, 'getRepos'> | null,
  caches: () => readonly Pick<Map<string, unknown>, 'keys' | 'delete'>[]
): void {
  const registered = new Set(
    (store?.getRepos() ?? []).map((repo) => `${repo.id}\0${getRepoExecutionHostId(repo)}`)
  )
  for (const cache of caches()) {
    for (const key of cache.keys()) {
      if (!registered.has(key)) {
        cache.delete(key)
      }
    }
  }
}
