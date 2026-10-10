import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { isFreshNonDoneAgentStatus } from '../../shared/agent-status-freshness'
import { createAgentScratchWorktreeSourceMatcher } from '../../shared/agent-scratch-worktrees'
import type { Repo } from '../../shared/repo-types'
import type { GitWorktreeInfo, Worktree } from '../../shared/worktree/types'
import { resolveConfiguredWorktreeBasePaths } from '../../shared/worktree/configured-worktree-base-path'
import { WORKSPACE_CLEANUP_STALE_AGENT_IDLE_MS } from '../../shared/workspace-cleanup'

/** Reads the execution host's agent status store (the hook server's). */
export type WorkspaceCleanupAgentStatusReader = () => readonly AgentStatusIpcPayload[]

export type WorkspaceCleanupStaleAgentClassifier = (
  worktree: Pick<Worktree, 'id' | 'path' | 'isMainWorktree' | 'lastActivityAt'>,
  scannedAt: number
) => boolean

/**
 * Flags coding-agent scratch worktrees (`.claude/worktrees/*`, `.gsd-workspaces/*`) that sat idle
 * past the threshold with no live agent in them or in the checkout that owns them.
 *
 * Why the owning checkout counts: a sub-agent's scratch worktree is driven from the parent
 * session's pane, so the store attributes that live agent to the parent, not to the scratch path.
 */
export function createWorkspaceCleanupStaleAgentClassifier(args: {
  repo: Pick<Repo, 'id' | 'path' | 'worktreeBasePath'>
  gitWorktrees: readonly Pick<GitWorktreeInfo, 'path' | 'isMainWorktree'>[]
  readAgentStatusSnapshot?: WorkspaceCleanupAgentStatusReader
}): WorkspaceCleanupStaleAgentClassifier {
  const { repo, gitWorktrees, readAgentStatusSnapshot } = args
  if (!readAgentStatusSnapshot) {
    // Without the store, agent liveness is unverifiable, and that is never evidence of idleness.
    return () => false
  }
  const checkoutPaths = [
    ...new Set([
      repo.path,
      ...gitWorktrees.filter((worktree) => worktree.isMainWorktree).map((worktree) => worktree.path)
    ])
  ]
  const matchSource = createAgentScratchWorktreeSourceMatcher(
    checkoutPaths,
    resolveConfiguredWorktreeBasePaths(repo)
  )
  const ownerWorktreeIds = checkoutPaths.map((checkoutPath) => `${repo.id}::${checkoutPath}`)
  let liveWorktreeIds: ReadonlySet<string> | undefined
  const readLiveWorktreeIds = (): ReadonlySet<string> => {
    liveWorktreeIds ??= collectLiveAgentWorktreeIds(readAgentStatusSnapshot())
    return liveWorktreeIds
  }

  return (worktree, scannedAt) => {
    if (worktree.isMainWorktree || matchSource(worktree.path)?.kind !== 'built-in') {
      return false
    }
    // Why: 0 means no activity was ever observed, which proves nothing about idleness.
    if (
      worktree.lastActivityAt <= 0 ||
      scannedAt - worktree.lastActivityAt < WORKSPACE_CLEANUP_STALE_AGENT_IDLE_MS
    ) {
      return false
    }
    const live = readLiveWorktreeIds()
    return !live.has(worktree.id) && !ownerWorktreeIds.some((ownerId) => live.has(ownerId))
  }
}

// Same attribution `worktree ps` uses: a row without a worktree id is not attributable here.
function collectLiveAgentWorktreeIds(rows: readonly AgentStatusIpcPayload[]): Set<string> {
  const now = Date.now()
  const live = new Set<string>()
  for (const row of rows) {
    if (row.providerSessionOnly === true || !row.worktreeId) {
      continue
    }
    const fresh = isFreshNonDoneAgentStatus(
      {
        state: row.state,
        updatedAt: row.receivedAt,
        evidenceObservedAt: row.evidenceObservedAt,
        restoredUnconfirmed: row.restoredUnconfirmed,
        ...(row.structuredHost === 'owned' ? { structuredHostOwned: true as const } : {})
      },
      now
    )
    if (fresh) {
      live.add(row.worktreeId)
    }
  }
  return live
}
