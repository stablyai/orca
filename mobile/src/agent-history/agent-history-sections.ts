import {
  filterAiVaultSessions,
  groupAiVaultSessions
} from '../../../src/shared/ai-vault-session-filters'
import { AI_VAULT_AGENTS } from '../../../src/shared/ai-vault-types'
import type { AiVaultScope, AiVaultSession } from '../../../src/shared/ai-vault-types'
import {
  buildMobileAgentHistoryCard,
  type MobileAgentHistoryCard
} from './agent-history-session-card'

// Why: `data` (not `cards`) is the field name React Native's SectionList reads
// for each section's rows — naming it anything else renders empty sections.
export type MobileAgentHistorySection = {
  key: string
  label: string
  data: MobileAgentHistoryCard[]
}

// Why: the host treats scopePaths as a WIDENING union (it adds in-scope sessions
// beyond the recency cap, never restricts), so the Workspace/Project tabs must
// narrow on the client like the desktop panel does. Mobile has no project-key
// metadata, so both scoped tabs narrow by cwd path-prefix: Workspace = the active
// worktree path, Project = the active worktree + same-repo siblings (the same set
// deriveMobileAiVaultScopePaths produces). 'all' applies no path narrowing.
// hideEmptySessions matches the desktop default.
export function buildMobileAgentHistorySections(
  sessions: readonly AiVaultSession[],
  options: {
    query: string
    scope: AiVaultScope
    scopeFilterPaths: readonly string[]
    activeWorktreePath: string | null
    now: number
  }
): MobileAgentHistorySection[] {
  // Why: narrow scoped tabs by cwd path-prefix. When the worktree list hasn't
  // loaded yet, scopeFilterPaths is empty — fall back to unnarrowed rather than
  // filtering everything out (which would flash an empty list); the memo re-runs
  // with real paths once worktree.ps resolves.
  const narrowByPath = options.scope !== 'all' && options.scopeFilterPaths.length > 0
  const filtered = filterAiVaultSessions(sessions, {
    query: options.query,
    agents: AI_VAULT_AGENTS,
    scope: narrowByPath ? 'workspace' : 'all',
    sort: 'updated',
    activeWorktreePaths: narrowByPath ? options.scopeFilterPaths : [],
    hideEmptySessions: true
  })

  const groups = groupAiVaultSessions(filtered, 'folder')
  return groups.map((group) => ({
    key: group.key,
    label: group.label,
    data: group.sessions.map((session) =>
      buildMobileAgentHistoryCard(session, options.activeWorktreePath, options.now)
    )
  }))
}
