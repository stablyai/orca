import type { Repo } from '../../../../shared/repo-types'
import { isAgentScratchRepoRootPath } from '../../../../shared/agent-scratch-worktrees'
import {
  getRepoRoutingConnectionId,
  getRepoSshConnectionId
} from '../../../../shared/execution-host'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import {
  resolveLocalProjectRuntimeForRepo,
  type ProjectRuntimeResolutionStore
} from '../../../workspaces/execution-host/local-project-runtime-resolution'

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
