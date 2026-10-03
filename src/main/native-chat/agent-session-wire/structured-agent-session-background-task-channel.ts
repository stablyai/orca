import type {
  AgentSessionBackgroundTaskState,
  AgentSessionHistoryRequest,
  AgentSessionHistoryResult
} from '../../../shared/agent-session-wire'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { structuredChildWorkLegacyTasks } from '../../../shared/structured-agent-session-child-work-legacy'
import { structuredRunningChildWork } from '../../../shared/agent-child-work-listing'
import { readStructuredAgentSessionHistoryResult } from './structured-agent-session-history-result'
import { tryReadQueuePublication } from './structured-agent-session-queued-publication'
import type { AgentSessionHistoryScope } from './agent-session-history-page'
import type {
  AgentSessionSubscribers,
  AgentSessionSubscribeInput
} from './structured-agent-session-subscribers'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'

/** The chat strip's roster: the host's running child records for one session, the same selection
 *  the session list carries, with the legacy task rows an older client reads derived from them. No
 *  running child is `null`, and the strip hides. Each subscriber's frames carry it; see
 *  `agent-session-subscriber-frame-fields`. */
export class StructuredAgentSessionBackgroundTaskChannel {
  constructor(
    private readonly deps: StructuredAgentSessionHostDeps,
    private readonly sessions: StructuredAgentSessionConversations,
    private readonly subscribers: AgentSessionSubscribers,
    /** The host's accessor: opens a conversation at rest, and never starts an agent. */
    private readonly conversation: (
      sessionId: string
    ) => Promise<StructuredAgentSessionHostSession>,
    private readonly readChildWork: (sessionId: string) => AgentChildWorkView[] | undefined
  ) {}

  /** `scope` is for in-process readers; a wire request reads every agent's rows. */
  async history(
    request: AgentSessionHistoryRequest,
    scope?: AgentSessionHistoryScope
  ): Promise<AgentSessionHistoryResult> {
    const journal = (await this.conversation(request.sessionId)).journal
    const result = readStructuredAgentSessionHistoryResult({
      journal,
      record: this.deps.store.getRecord(request.sessionId),
      request,
      scope
    })
    const backgroundTasks = this.read(request.sessionId)
    const queue = tryReadQueuePublication(journal)
    const hostNow = this.deps.now?.() ?? Date.now()
    return {
      ...result,
      page: {
        ...result.page,
        hostNow,
        // A stale history answer never replaces newer live subscription state;
        // the client's reducer keeps live-over-history precedence.
        ...(queue !== undefined
          ? { queuedMessages: queue.queuedMessages, queuePause: queue.queuePause }
          : {}),
        backgroundTasks
      }
    }
  }

  /** Resolves once the conversation is open and the subscriber holds its opening frame. */
  async subscribe(input: AgentSessionSubscribeInput): Promise<() => void> {
    const session = await this.conversation(input.sessionId)
    return this.subscribers.open({
      ...input,
      journal: session.journal,
      fence: structuredAgentSessionConversationFence(this.deps.store, input.sessionId)
    })
  }

  /** The session's child records changed; subscribers whose roster differs get the new one. */
  publish(sessionId: string): void {
    if (this.sessions.get(sessionId)) {
      this.subscribers.republishBackgroundTasks(
        sessionId,
        structuredAgentSessionConversationFence(this.deps.store, sessionId)
      )
    }
  }

  /** Always an answer, never "unknown": the child records are the roster whether or not a provider
   *  holds the session, and a parent row the store lacks has no children in it. */
  read(sessionId: string): AgentSessionBackgroundTaskState | null {
    const session = this.sessions.get(sessionId)
    const views = structuredRunningChildWork((session && this.readChildWork(sessionId)) ?? [])
    if (!session || views.length === 0) {
      return null
    }
    const stops = this.deps.adapter.backgroundTaskStops?.(sessionId)
    const { tasks, settledTasks } = structuredChildWorkLegacyTasks(views, session.params.provider)
    return {
      state: 'monitoring',
      ...(tasks ? { tasks } : {}),
      ...(settledTasks ? { settledTasks } : {}),
      ...(stops?.supportsTaskStop ? { supportsTaskStop: true } : {}),
      // A session no live provider holds has nothing a stop could reach.
      ...(stops?.supportsStopAll ? {} : { supportsStopAll: false }),
      children: views
    }
  }
}
