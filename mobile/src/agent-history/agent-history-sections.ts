import {
  filterAiVaultSessions,
  groupAiVaultSessions
} from '../../../src/shared/ai-vault/session-display/ai-vault-session-filters'
import {
  AI_VAULT_AGENTS,
  type AiVaultScope,
  type AiVaultSession
} from '../../../src/shared/ai-vault/contracts/ai-vault-types'

import type { MobileSegment } from '../components/MobileSegmentedControl'
import type { Translate } from '../i18n/mobile-i18n'
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

/** Workspace, project, and all. On the phone, project means the active repo. */
export function mobileAgentHistoryScopeSegments(t: Translate): MobileSegment<AiVaultScope>[] {
  return [
    { value: 'workspace', label: t('agentHistory.panel.workspace', 'Workspace') },
    { value: 'project', label: t('agentHistory.panel.project', 'Project') },
    { value: 'all', label: t('agentHistory.panel.all', 'All') }
  ]
}

// Host scopePaths only widen discovery, so narrow Workspace/Project by cwd prefix client-side (desktop's scope paths); All stays unfiltered.
// Mobile lacks project-key metadata; hideEmptySessions matches desktop default.
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
  // Until worktree.ps supplies prefixes, leave scoped tabs unfiltered rather than flash empty; memo reruns when paths arrive.
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
