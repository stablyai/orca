import {
  filterAiVaultSessions,
  groupAiVaultSessions
} from '../../../src/shared/ai-vault/session-display/ai-vault-session-filters'
import type {
  AiVaultAgent,
  AiVaultScope,
  AiVaultSession,
  AiVaultSort
} from '../../../src/shared/ai-vault/contracts/ai-vault-types'

import {
  buildMobileAgentHistoryCard,
  type MobileAgentHistoryCard
} from './agent-history-session-card'

// SectionList requires data field; naming it cards renders no rows.
export type MobileAgentHistorySection = {
  key: string
  label: string
  data: MobileAgentHistoryCard[]
}

// Host scopePaths only widen discovery, so narrow Workspace/Project by cwd prefix client-side (desktop's scope paths); All stays unfiltered.
export function buildMobileAgentHistorySections(
  sessions: readonly AiVaultSession[],
  options: {
    query: string
    agents: readonly AiVaultAgent[]
    sort: AiVaultSort
    scope: AiVaultScope
    scopeFilterPaths: readonly string[]
    activeWorktreePath: string | null
    now: number
  }
): MobileAgentHistorySection[] {
  // Until worktree.ps supplies prefixes, leave scoped tabs unfiltered rather than flash empty; memo reruns when paths arrive.
  const narrowByPath = options.scope !== 'all' && options.scopeFilterPaths.length > 0
  const filtered = filterAiVaultSessions(sessions, {
    query: options.query,
    agents: options.agents,
    scope: narrowByPath ? 'workspace' : 'all',
    sort: options.sort,
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
