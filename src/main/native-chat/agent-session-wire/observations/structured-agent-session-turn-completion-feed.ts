// Derive attention edges on the host so background chats work without a renderer reader.
// Completion and prompt events are live-only; late subscribers receive no replay.

import { chatTurnRunning, type ChatStateReader } from './chat-turn-running'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type {
  AgentSessionTurnCompletion,
  AgentSessionTurnCompletionEvent
} from '../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import type {
  AgentSessionAttentionEdge,
  StructuredAttentionState
} from '../../../../shared/agent-session/view/agent-session-attention'
import type { AgentChildWorkLivenessCandidate } from '../../../../shared/agent-status/child-work/agent-status-child-work-liveness'
import type { StructuredAgentSessionLatestRequest } from '../../../../shared/agent-session/requests/structured-agent-session-latest-request'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import {
  hearsTurnCompletionEdge,
  type TurnCompletionAudience
} from './structured-agent-session-turn-completion-audience'
import { structuredAgentSessionTurnHold } from './structured-agent-session-turn-hold'
import type {
  StructuredAgentSessionStatusState,
  StructuredAgentSessionJournalProjection
} from './structured-agent-session-status-journal-projection'

export type StructuredAgentSessionTurnCompletionSubscriber = {
  id: string
  emit: (event: AgentSessionTurnCompletionEvent) => void
  /** Older clients misread prompt arms, so delivery requires opt-in. */
  includePrompts?: boolean
  /** Also hears an end live work holds, when it ends, and not again when it is announced. */
  includeHeld?: boolean
  /** In-process reconciliation on restore and prompt removal. */
  onState?: (state: StructuredAttentionState) => void
  /** The session closed; a turn it was running ends with no completion. */
  onClosed?: (sessionId: string) => void
  /** Every status observation, before any filtering: whether its lead turn runs now. */
  onObserved?: (sessionId: string, running: boolean) => void
  /** Given a reader of a chat's status as its journal stands now (null when not loaded here). */
  readsState?: (read: ChatStateReader) => void
}

type CompletionFeedCursor = { epoch: string; sequence: number }

type CompletionFeedSession = {
  journal: Pick<AgentSessionJournal, 'cursor'>
  params: { location: AgentSessionRecord['location'] }
}

export type StructuredAgentSessionTurnCompletionFeedDeps = {
  sessions: ReadonlyMap<string, CompletionFeedSession>
  now: () => number
  /** Reuse this commit’s status projection so events identify the request shown in the row. */
  readStatusState: (
    sessionId: string,
    journal?: AgentSessionJournal
  ) => Promise<StructuredAgentSessionStatusState | null>
  readChildWork: (sessionId: string) => readonly AgentChildWorkLivenessCandidate[] | undefined
  /** The person's Skip on the chat's async questions, saved on its record. */
  readAsyncQuestionsSkippedThrough?: (sessionId: string) => string | undefined
}

type RequestMark = Pick<StructuredAgentSessionLatestRequest, 'kind' | 'id'>

/** Missing baseline makes first observation silent; settled/prompts track already-accounted edges. */
type SessionBaseline = CompletionFeedCursor & {
  settled: RequestMark | null
  // The end running workers hold, and the subscribers already told it.
  held: (RequestMark & { heard: Set<string> }) | null
  prompts: ReadonlySet<string>
}

const sameMark = (a: RequestMark | null, b: RequestMark) => a?.kind === b.kind && a.id === b.id

function settledMark(request: StructuredAgentSessionLatestRequest | null): RequestMark | null {
  return request && request.turnState !== 'running' ? { kind: request.kind, id: request.id } : null
}

export class StructuredAgentSessionTurnCompletionFeed {
  private readonly subscribers = new Map<string, StructuredAgentSessionTurnCompletionSubscriber>()
  private readonly baselines = new Map<string, SessionBaseline>()

  constructor(private readonly deps: StructuredAgentSessionTurnCompletionFeedDeps) {}

  subscribe(subscriber: StructuredAgentSessionTurnCompletionSubscriber): () => void {
    this.subscribers.set(subscriber.id, subscriber)
    subscriber.readsState?.(async (id) =>
      this.deps.sessions.has(id) ? this.deps.readStatusState(id) : null
    )
    return () => this.unsubscribe(subscriber.id)
  }

  unsubscribe(id: string): void {
    const subscriber = this.subscribers.get(id)
    if (!subscriber) {
      return
    }
    this.subscribers.delete(id)
    try {
      subscriber.emit({ type: 'end' })
    } catch {
      // The transport is already gone; teardown must remain idempotent.
    }
  }

  /** A closed session: its reattachment baselines silently instead of announcing old work. */
  forget(sessionId: string): void {
    this.baselines.delete(sessionId)
    for (const subscriber of this.subscribers.values()) {
      try {
        subscriber.onClosed?.(sessionId)
      } catch {
        // One subscriber's bookkeeping cannot cost another its close.
      }
    }
  }

  /** When prompt and clean completion coincide, keep prompt identity; send completion only to legacy clients.
   * Failures reach everyone; first/historical observations and repeated identities stay silent. */
  async observe(
    sessionId: string,
    journal?: AgentSessionJournal,
    options?: { historical?: boolean }
  ): Promise<void> {
    const session = this.deps.sessions.get(sessionId)
    const state = session ? await this.deps.readStatusState(sessionId, journal) : null
    if (!session || !state) {
      return
    }
    const cursor = (journal ?? session.journal).cursor()
    this.observeState(sessionId, session, cursor, state, options)
  }

  /** SQL status and completion share the validated observer answer, without a second read. */
  observeProjection(
    sessionId: string,
    projection: Pick<StructuredAgentSessionJournalProjection, 'epoch' | 'sequence' | 'state'>,
    options?: { historical?: boolean }
  ): void {
    const session = this.deps.sessions.get(sessionId)
    if (session) {
      const { epoch, sequence } = projection
      this.observeState(sessionId, session, { epoch, sequence }, projection.state, options)
    }
  }

  private observeState(
    sessionId: string,
    session: CompletionFeedSession,
    cursor: CompletionFeedCursor,
    state: StructuredAgentSessionStatusState,
    options?: { historical?: boolean }
  ): void {
    const running = chatTurnRunning(state)
    for (const subscriber of this.subscribers.values()) {
      try {
        subscriber.onObserved?.(sessionId, running)
      } catch {
        // One reader's failure never costs this commit its attention edge.
      }
    }
    const request = state.latestRequest
    const prompts = new Set(state.pendingPromptIds)
    const baseline = this.baselines.get(sessionId)
    if (!baseline || options?.historical || [...baseline.prompts].some((id) => !prompts.has(id))) {
      this.publishState(session, sessionId, state.pendingPromptIds)
    }
    if (!baseline || options?.historical) {
      this.baselines.set(sessionId, {
        ...cursor,
        settled: settledMark(request),
        held: null,
        prompts
      })
      return
    }
    if (baseline.epoch !== cursor.epoch || cursor.sequence < baseline.sequence) {
      // Rewind/import changes identity without a provider edge; silently replace the baseline.
      baseline.epoch = cursor.epoch
      baseline.sequence = cursor.sequence
      baseline.settled = settledMark(request)
      baseline.held = null
      baseline.prompts = prompts
      return
    }
    baseline.sequence = cursor.sequence
    const raised = state.pendingPromptIds.find((id) => !baseline.prompts.has(id))
    baseline.prompts = prompts
    const settled = this.settledCompletion(sessionId, session, state, baseline)
    if (settled) {
      const { completion, held, heard } = settled
      completion.journalCursor = cursor
      const restatesPrompt = completion.awaitingUser === true && completion.outcome === 'success'
      const audience = held ? 'held-aware' : restatesPrompt ? 'legacy' : 'all'
      // A held end goes only to those who hear held ends, and not to them again once announced.
      this.broadcast({ type: 'completion', completion }, audience, held ?? heard)
      if (!held && !restatesPrompt) {
        return
      }
    }
    if (raised === undefined) {
      return
    }
    this.broadcast(
      {
        type: 'prompt',
        prompt: {
          scope: session.params.location,
          sessionId,
          promptId: raised,
          journalCursor: cursor,
          raisedAt: this.deps.now()
        }
      },
      'prompt-aware'
    )
  }

  private publishState(
    session: CompletionFeedSession,
    sessionId: string,
    pendingPromptIds: readonly string[]
  ): void {
    for (const subscriber of this.subscribers.values()) {
      try {
        subscriber.onState?.({ scope: session.params.location, sessionId, pendingPromptIds })
      } catch {
        // Delivery bookkeeping cannot cost this commit its attention edge.
      }
    }
  }

  private settledCompletion(
    sessionId: string,
    session: CompletionFeedSession,
    state: StructuredAgentSessionStatusState,
    baseline: SessionBaseline
  ): {
    completion: AgentSessionTurnCompletion
    held?: Set<string>
    heard?: Set<string>
  } | null {
    const request = state.latestRequest
    if (request?.turnState === 'running') {
      // Clear on running so each running-to-settled transition can fire, even for a reused ID.
      baseline.settled = null
      baseline.held = null
      return null
    }
    if (state.owesWork) {
      return null
    }
    if (
      !request ||
      (baseline.settled?.kind === request.kind && baseline.settled.id === request.id)
    ) {
      return null
    }
    // Live work defers this end. One running workers hold is news now to those who hear held ends:
    // its words are sent with it. A continuing goal's is not, as its later turns finish the answer.
    const hold = structuredAgentSessionTurnHold(
      state,
      request,
      () => this.deps.readChildWork(sessionId),
      () => this.deps.readAsyncQuestionsSkippedThrough?.(sessionId)
    )
    if (hold) {
      if (hold === 'goal' || sameMark(baseline.held, request)) {
        return null
      }
      baseline.held = { kind: request.kind, id: request.id, heard: new Set() }
      return {
        completion: this.completionOf(sessionId, session, state, request.id, 'success'),
        held: baseline.held.heard
      }
    }
    baseline.settled = settledMark(request)
    // No outcome means unknown; inferring success would alert on failures.
    if (!request.outcome) {
      return null
    }
    return {
      completion: this.completionOf(sessionId, session, state, request.id, request.outcome),
      ...(baseline.held && sameMark(baseline.held, request) ? { heard: baseline.held.heard } : {})
    }
  }

  private completionOf(
    sessionId: string,
    session: CompletionFeedSession,
    state: StructuredAgentSessionStatusState,
    turnId: string,
    outcome: AgentSessionTurnCompletion['outcome']
  ): AgentSessionTurnCompletion {
    return {
      scope: session.params.location,
      sessionId,
      turnId,
      outcome,
      completedAt: this.deps.now(),
      // Include attention here: remote clients receive status and completion streams unordered.
      ...(state.summary.status === 'attention' ? { awaitingUser: true as const } : {}),
      ...(state.turnFailure ? { failure: state.turnFailure } : {}),
      ...(state.quiet ? { quiet: true as const } : {})
    }
  }

  /** `heard`: for a held end, records who hears it; for any other, those who already did. */
  private broadcast(
    event: AgentSessionAttentionEdge,
    audience: TurnCompletionAudience,
    heard?: Set<string>
  ): void {
    const recording = audience === 'held-aware'
    for (const subscriber of this.subscribers.values()) {
      if (
        !hearsTurnCompletionEdge(subscriber, audience) ||
        (!recording && heard?.has(subscriber.id))
      ) {
        continue
      }
      if (recording) {
        heard?.add(subscriber.id)
      }
      try {
        subscriber.emit(event)
      } catch {
        this.subscribers.delete(subscriber.id)
      }
    }
  }
}
