// Turns the status summary's sessions into rows the panel can render and act on.
// Workspace lookup is injected so this stays synchronous and testable: resolving a branch would
// need live git state, which main does not hold, and an async hop here would stall repaints.
import { getRepoIdFromWorktreeId } from '../../shared/worktree-id'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { NotchSession } from '../../shared/notch/notch-status-summary'
import type { NotchRow } from '../../shared/notch/notch-snapshot'
import { buildNotchRowLabel } from './notch-row-label'

export type NotchWorkspaceLookup = {
  /** Display name for a worktree or folder workspace id, or null when unknown. */
  getDisplayName(worktreeId: string): string | null
}

export type BuildNotchRowsArgs = {
  sessions: readonly NotchSession[]
  lookup: NotchWorkspaceLookup
  fallbackTitle: string
}

export function buildNotchRows({
  sessions,
  lookup,
  fallbackTitle
}: BuildNotchRowsArgs): NotchRow[] {
  return sessions.map((session) => {
    const worktreeId = session.worktreeId ?? null
    const displayName = worktreeId ? lookup.getDisplayName(worktreeId) : null
    const { title, subtitle } = buildNotchRowLabel({
      // Branch and head are unavailable in main, so every row takes the same no-git-identity
      // path folder workspaces already use — the label module handles it.
      worktree: displayName === null ? null : { displayName, branch: '', head: '' },
      agentType: session.agentType,
      fallbackTitle
    })
    const parsed = parsePaneKey(session.paneKey)
    return {
      paneKey: session.paneKey,
      lane: session.lane,
      state: session.state,
      title,
      subtitle,
      agentType: session.agentType ?? null,
      stateStartedAt: session.stateStartedAt,
      worktreeId,
      repoId: worktreeId ? getRepoIdFromWorktreeId(worktreeId) : null,
      // tabId on the payload wins; the pane key is the fallback for rows that predate it.
      tabId: session.tabId ?? parsed?.tabId ?? null,
      leafId: parsed?.leafId ?? null
    }
  })
}
