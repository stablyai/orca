import type { Repo } from '../../shared/repo-types'
import { isAgentScratchRepoRootPath } from '../../shared/agent-scratch-worktrees'
import { getRepoRoutingConnectionId } from '../../shared/execution-host'

const WORKTREE_SCAN_CACHE_TTL_MS = 30_000
const WORKTREE_SCAN_AGENT_SCRATCH_TTL_MS = 5 * 60_000

export function resolveWorktreeScanCacheTtlMs(
  repo: Pick<Repo, 'path' | 'connectionId' | 'executionHostId'>
): number {
  return !getRepoRoutingConnectionId(repo) && isAgentScratchRepoRootPath(repo.path)
    ? WORKTREE_SCAN_AGENT_SCRATCH_TTL_MS
    : WORKTREE_SCAN_CACHE_TTL_MS
}
