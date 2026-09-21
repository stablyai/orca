import type {
  AgentSessionBackgroundTaskState,
  AgentSessionHistoryRequest,
  AgentSessionHistoryResult
} from '../../../shared/agent-session-wire'
import { readStructuredAgentSessionHistoryResult } from './structured-agent-session-history-result'
import type {
  AgentSessionSubscribers,
  AgentSessionSubscribeInput
} from './structured-agent-session-subscribers'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

export class StructuredAgentSessionBackgroundTaskChannel {
  constructor(
    private readonly deps: StructuredAgentSessionHostDeps,
    private readonly sessions: Map<string, StructuredAgentSessionHostSession>,
    private readonly subscribers: AgentSessionSubscribers,
    private readonly requireSession: (sessionId: string) => StructuredAgentSessionHostSession,
    private readonly handoffStatus: (
      sessionId: string
    ) => Parameters<AgentSessionSubscribers['open']>[0]['handoff']
  ) {}

  history(request: AgentSessionHistoryRequest): AgentSessionHistoryResult {
    const result = readStructuredAgentSessionHistoryResult({
      journal: this.requireSession(request.sessionId).journal,
      record: this.deps.store.getRecord(request.sessionId),
      request
    })
    const backgroundTasks = this.state(request.sessionId)
    return backgroundTasks === undefined
      ? result
      : { ...result, page: { ...result.page, backgroundTasks } }
  }

  subscribe(input: AgentSessionSubscribeInput): () => void {
    const session = this.requireSession(input.sessionId)
    const backgroundTasks = this.state(input.sessionId)
    return this.subscribers.open({
      ...input,
      journal: session.journal,
      fence: this.deps.store.getRecord(input.sessionId)?.lease.runtimeFence ?? 0,
      handoff: this.handoffStatus(input.sessionId),
      ...(backgroundTasks !== undefined ? { backgroundTasks } : {})
    })
  }

  publish(sessionId: string, publishedState?: AgentSessionBackgroundTaskState | null): void {
    const session = this.sessions.get(sessionId)
    const state = publishedState !== undefined ? publishedState : this.state(sessionId)
    if (session && state !== undefined) {
      this.subscribers.backgroundTasks(sessionId, state, session.fence)
    }
  }

  private state(sessionId: string): AgentSessionBackgroundTaskState | null | undefined {
    return this.deps.adapter.backgroundTaskState?.(sessionId)
  }
}
