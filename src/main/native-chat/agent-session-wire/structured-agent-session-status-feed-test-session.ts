import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionProviderChildIdentity } from './structured-agent-session-host-types'

export function indexedStatusFeedSession<P extends AgentSessionHandleProvider = 'codex'>(session: {
  journal: AgentSessionJournal
  child?: (StructuredAgentSessionProviderChildIdentity & { phase: 'starting' | 'ready' }) | null
  provider?: P
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
      provider: session.provider ?? ('codex' as const)
    }
  }
}

/** One child record as the views a status sink hands the feed. */
export function statusFeedChildView(over: Partial<AgentChildWorkView> = {}): AgentChildWorkView {
  return {
    id: 'child-1',
    providerId: 'task-1',
    kind: 'agent',
    name: 'deep_review',
    agentType: 'deep_review',
    state: 'working',
    membership: 'live',
    firstObservedAt: 100,
    observedAt: 100,
    stoppable: true,
    invocation: { invocationId: 'toolu_1', generation: 1 },
    ...over
  }
}
