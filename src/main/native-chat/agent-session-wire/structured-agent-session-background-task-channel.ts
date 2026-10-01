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
 *  running child is `null`, and the strip hides. */
export class StructuredAgentSessionBackgroundTaskChannel {
  private readonly published = new Map<string, string>()

  constructor(
    private readonly deps: StructuredAgentSessionHostDeps,
    private readonly sessions: StructuredAgentSessionConversations,
    private readonly subscribers: AgentSessionSubscribers,
    /** The host's accessor: opens a conversation at rest, and never starts an agent. */
    private readonly conversation: (
      sessionId: string
    ) => Promise<StructuredAgentSessionHostSession>,
    private readonly readChildWork: (sessionId: string) => AgentChildWorkView[] | undefined
  ) {
    // A closed conversation's last roster is not kept for the host's lifetime.
    sessions.observeClose((sessionId) => this.published.delete(sessionId))
  }

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
    const backgroundTasks = this.state(request.sessionId)
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

  /** Re-read after the session's child records changed; an unchanged roster sends nothing. */
  publish(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    // Explicit null once a roster was sent, not silence: a reader keeps its last roster on
    // `undefined`, and a closing provider stops answering before its records are gone.
    const read = this.state(sessionId)
    const state = read === undefined && this.published.has(sessionId) ? null : read
    if (!session || state === undefined) {
      return
    }
    const fingerprint = JSON.stringify(state)
    if (this.published.get(sessionId) === fingerprint) {
      return
    }
    // "None" is remembered too, so a session with no children sends it once, not on every change;
    // the entry goes when the conversation closes.
    this.published.set(sessionId, fingerprint)
    this.subscribers.backgroundTasks(
      sessionId,
      state,
      structuredAgentSessionConversationFence(this.deps.store, sessionId)
    )
  }

  private state(sessionId: string): AgentSessionBackgroundTaskState | null | undefined {
    const session = this.sessions.get(sessionId)
    const stored = session ? this.readChildWork(sessionId) : undefined
    if (!session || stored === undefined) {
      return undefined
    }
    const views = structuredRunningChildWork(stored)
    const stops = this.deps.adapter.backgroundTaskStops?.(sessionId)
    if (views.length === 0) {
      // As before: a session no live provider holds says nothing, a live one says "none".
      return stops === undefined ? undefined : null
    }
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
