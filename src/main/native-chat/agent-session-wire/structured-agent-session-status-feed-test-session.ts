import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionProviderChildIdentity } from './structured-agent-session-host-types'

export function indexedStatusFeedSession(session: {
  journal: AgentSessionJournal
  child?: (StructuredAgentSessionProviderChildIdentity & { phase: 'starting' | 'ready' }) | null
}) {
  return {
    journal: session.journal,
    ...(session.child !== undefined ? { child: session.child } : {}),
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
