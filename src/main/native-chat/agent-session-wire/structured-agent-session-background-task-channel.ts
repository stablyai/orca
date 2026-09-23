import type {
  AgentSessionBackgroundTaskState,
  AgentSessionHistoryRequest,
  AgentSessionHistoryResult
} from '../../../shared/agent-session-wire'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { structuredChildWorkLegacyTasks } from '../../../shared/structured-agent-session-child-work-legacy'
import { readStructuredAgentSessionHistoryResult } from './structured-agent-session-history-result'
import type {
  AgentSessionSubscribers,
  AgentSessionSubscribeInput
} from './structured-agent-session-subscribers'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

/** The chat strip's roster: the host's child records for one session, as the same views the status
 *  summary carries, with the legacy task rows an older client reads derived from them. */
export class StructuredAgentSessionBackgroundTaskChannel {
  private readonly published = new Map<string, string>()

  constructor(
    private readonly deps: StructuredAgentSessionHostDeps,
    private readonly sessions: Map<string, StructuredAgentSessionHostSession>,
    private readonly subscribers: AgentSessionSubscribers,
    private readonly requireSession: (sessionId: string) => StructuredAgentSessionHostSession,
    private readonly readChildWork: (sessionId: string) => AgentChildWorkView[] | undefined
  ) {}

  history(request: AgentSessionHistoryRequest): AgentSessionHistoryResult {
    const result = readStructuredAgentSessionHistoryResult({
      journal: this.requireSession(request.sessionId).journal,
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

  subscribe(input: AgentSessionSubscribeInput): () => void {
    const session = this.requireSession(input.sessionId)
    const backgroundTasks = this.state(input.sessionId)
    return this.subscribers.open({
      ...input,
      journal: session.journal,
      fence: this.deps.store.getRecord(input.sessionId)?.lease.runtimeFence ?? 0,
      ...(backgroundTasks !== undefined ? { backgroundTasks } : {})
    })
  }

  /** Re-read after the session's child records changed; an unchanged roster sends nothing. */
  publish(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    // Explicit null once rows were sent, not silence: a reader keeps its last roster on
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
    if (state === null) {
      this.published.delete(sessionId)
    } else {
      this.published.set(sessionId, fingerprint)
    }
    this.subscribers.backgroundTasks(sessionId, state, session.fence)
  }

  private state(sessionId: string): AgentSessionBackgroundTaskState | null | undefined {
    const session = this.sessions.get(sessionId)
    const views = session ? this.readChildWork(sessionId) : undefined
    if (!session || views === undefined) {
      return undefined
    }
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
