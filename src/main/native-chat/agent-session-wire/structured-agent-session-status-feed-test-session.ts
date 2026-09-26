import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export function indexedStatusFeedSession(session: {
  journal: AgentSessionJournal
  hasProviderChild?: boolean
  providerChildPhase?: 'starting' | 'ready'
  fence?: number
}) {
  return {
    journal: session.journal,
    fence: session.fence ?? 1,
    ...(session.hasProviderChild !== undefined
      ? { hasProviderChild: session.hasProviderChild }
      : {}),
    ...(session.providerChildPhase ? { providerChildPhase: session.providerChildPhase } : {}),
    params: {
      location: {
        executionHostId: 'local' as const,
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'git-worktree' as const
      },
      provider: 'codex' as const
    }
  }
}
