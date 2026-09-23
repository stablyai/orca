import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export function indexedStatusFeedSession(session: {
  journal: AgentSessionJournal
  hasProviderChild?: boolean
  providerChildPhase?: 'starting' | 'ready'
  fence?: number
  provider?: AgentSessionHandleProvider
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
