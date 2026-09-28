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
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'

export class StructuredAgentSessionBackgroundTaskChannel {
  constructor(
    private readonly deps: StructuredAgentSessionHostDeps,
    private readonly sessions: Map<string, StructuredAgentSessionHostSession>,
    private readonly subscribers: AgentSessionSubscribers,
    /** The host's accessor: opens a conversation at rest, and never starts an agent. */
    private readonly conversation: (
      sessionId: string
    ) => Promise<StructuredAgentSessionHostSession>,
    /** Task edges change the status summary too; the feed's equality check
     *  keeps a no-op re-projection from reaching subscribers. */
    private readonly onPublished: (sessionId: string) => void
  ) {}

  async history(request: AgentSessionHistoryRequest): Promise<AgentSessionHistoryResult> {
    const result = readStructuredAgentSessionHistoryResult({
      journal: (await this.conversation(request.sessionId)).journal,
      record: this.deps.store.getRecord(request.sessionId),
      request
    })
    const backgroundTasks = this.state(request.sessionId)
    const hostNow = this.deps.now?.() ?? Date.now()
    return {
      ...result,
      page: {
        ...result.page,
        hostNow,
        ...(backgroundTasks !== undefined ? { backgroundTasks } : {})
      }
    }
  }

  /** Resolves once the conversation is open and the subscriber holds its opening frame. */
  async subscribe(input: AgentSessionSubscribeInput): Promise<() => void> {
    const session = await this.conversation(input.sessionId)
    const backgroundTasks = this.state(input.sessionId)
    return this.subscribers.open({
      ...input,
      journal: session.journal,
      fence: structuredAgentSessionConversationFence(this.deps.store, input.sessionId),
      ...(backgroundTasks !== undefined ? { backgroundTasks } : {})
    })
  }

  publish(sessionId: string, publishedState?: AgentSessionBackgroundTaskState | null): void {
    const session = this.sessions.get(sessionId)
    const state = publishedState !== undefined ? publishedState : this.state(sessionId)
    if (session && state !== undefined) {
      this.subscribers.backgroundTasks(
        sessionId,
        state,
        structuredAgentSessionConversationFence(this.deps.store, sessionId)
      )
      this.onPublished(sessionId)
    }
  }

  private state(sessionId: string): AgentSessionBackgroundTaskState | null | undefined {
    return this.deps.adapter.backgroundTaskState?.(sessionId)
  }
}
