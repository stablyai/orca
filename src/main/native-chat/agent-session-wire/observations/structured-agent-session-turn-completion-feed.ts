// Derive attention edges on the host so background chats work without a renderer reader.
// Completion and prompt events are live-only; late subscribers receive no replay.

import { chatTurnRunning, type ChatStateReader } from './chat-turn-running'
import { structuredAgentSessionAwaitsAnswer } from '../../../../shared/agent-session/view/structured-agent-session-async-questions'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type {
  AgentSessionTurnCompletion,
  AgentSessionTurnCompletionEvent
} from '../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import type {
  AgentSessionAttentionEdge,
  StructuredAttentionState
} from '../../../../shared/agent-session/view/agent-session-attention'
import {
  foldAgentLeadStatus,
  heldTurnCountsAsFinished
} from '../../../../shared/agent-status/lifecycle/agent-lead-status-fold'
import {
  agentChildWorkLiveness,
  type AgentChildWorkLivenessCandidate
} from '../../../../shared/agent-status/child-work/agent-status-child-work-liveness'
import type { StructuredAgentSessionLatestRequest } from '../../../../shared/agent-session/requests/structured-agent-session-latest-request'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type {
  StructuredAgentSessionStatusState,
  StructuredAgentSessionJournalProjection
} from './structured-agent-session-status-journal-projection'

export type StructuredAgentSessionTurnCompletionSubscriber = {
  id: string
  emit: (event: AgentSessionTurnCompletionEvent) => void
  /** Older clients misread prompt arms, so delivery requires opt-in. */
  includePrompts?: boolean
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

/** Missing baseline makes first observation silent; settled/prompts track already-accounted edges.
 *  accountedThrough is the journal sequence of the last end accounted for; turns behind it never
 *  merge, nor does that end's own turn when a later write moves its row. */
type SessionBaseline = CompletionFeedCursor & {
  settled: RequestMark | null
  accountedThrough: number
  accountedSettled: RequestMark | null
  prompts: ReadonlySet<string>
}

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
        accountedThrough: cursor.sequence,
        accountedSettled: settledMark(request),
        prompts
      })
      return
    }
    if (baseline.epoch !== cursor.epoch || cursor.sequence < baseline.sequence) {
      // Rewind/import changes identity without a provider edge; silently replace the baseline.
      baseline.epoch = cursor.epoch
      baseline.sequence = cursor.sequence
      baseline.settled = settledMark(request)
      baseline.accountedThrough = cursor.sequence
      baseline.accountedSettled = baseline.settled
      baseline.prompts = prompts
      return
    }
    baseline.sequence = cursor.sequence
    const raised = state.pendingPromptIds.find((id) => !baseline.prompts.has(id))
    baseline.prompts = prompts
    const completion = this.settledCompletion(sessionId, session, state, baseline, cursor.sequence)
    if (completion) {
      completion.journalCursor = cursor
      const restatesPrompt = completion.awaitingUser === true && completion.outcome === 'success'
      this.broadcast({ type: 'completion', completion }, restatesPrompt ? 'legacy' : 'all')
      if (!restatesPrompt) {
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
    baseline: SessionBaseline,
    sequence: number
  ): AgentSessionTurnCompletion | null {
    const request = state.latestRequest
    if (request?.turnState === 'running') {
      // Clear on running so each running-to-settled transition can fire, even for a reused ID.
      baseline.settled = null
      return null
    }
    // A held end merges into whichever end is announced next.
    if (state.owesWork) {
      return null
    }
    if (
      !request ||
      (baseline.settled?.kind === request.kind && baseline.settled.id === request.id)
    ) {
      // No end to announce: what was held stays unannounced, so it can't inflate a later end.
      baseline.accountedThrough = sequence
      baseline.accountedSettled = settledMark(request)
      return null
    }
    // Live work defers this end; its held turns still merge into whichever end is announced.
    if (this.heldByLiveWork(sessionId, state, request)) {
      return null
    }
    baseline.settled = settledMark(request)
    const accounted = { through: baseline.accountedThrough, settled: baseline.accountedSettled }
    baseline.accountedThrough = sequence
    baseline.accountedSettled = baseline.settled
    // No outcome means unknown; inferring success would alert on failures.
    if (!request.outcome) {
      return null
    }
    return {
      scope: session.params.location,
      sessionId,
      turnId: request.id,
      ...mergedTurns(state, accounted),
      outcome: request.outcome,
      completedAt: this.deps.now(),
      // Include attention here: remote clients receive status and completion streams unordered.
      ...(state.summary.status === 'attention' ? { awaitingUser: true as const } : {}),
      ...(state.turnFailure ? { failure: state.turnFailure } : {}),
      ...(state.quiet ? { quiet: true as const } : {})
    }
  }

  /** A successful turn is finished only when the combined row would be done; a held request stays unaccounted so a later observe can announce it. */
  private heldByLiveWork(
    sessionId: string,
    state: StructuredAgentSessionStatusState,
    request: StructuredAgentSessionLatestRequest
  ): boolean {
    if (request.outcome !== 'success' || state.summary.status === 'attention') {
      return false
    }
    // An open async question pauses the goal on the user, so it is news now.
    if (
      state.goalContinues &&
      !structuredAgentSessionAwaitsAnswer(
        state.summary.openAsyncQuestion,
        this.deps.readAsyncQuestionsSkippedThrough?.(sessionId)
      )
    ) {
      return true
    }
    const held = foldAgentLeadStatus({
      leadState: 'done',
      childWorkLiveness: agentChildWorkLiveness(this.deps.readChildWork(sessionId))
    })
    return (
      held.stateName !== 'done' &&
      !heldTurnCountsAsFinished(held, request.outcome, request.selfStarted === true)
    )
  }

  private broadcast(
    event: AgentSessionAttentionEdge,
    audience: 'all' | 'legacy' | 'prompt-aware'
  ): void {
    for (const subscriber of this.subscribers.values()) {
      const promptAware = subscriber.includePrompts === true
      if ((audience === 'legacy' && promptAware) || (audience === 'prompt-aware' && !promptAware)) {
        continue
      }
      try {
        subscriber.emit(event)
      } catch {
        this.subscribers.delete(subscriber.id)
      }
    }
  }
}

/** The answered turns behind this end since the last accounted end, counted with it, and their ids.
 *  A full window still counts as merged, with no ids, so a long run of held turns can't hide a
 *  dropped reply. Empty for a single-turn end. */
export function mergedTurns(
  state: Pick<StructuredAgentSessionStatusState, 'turnsBehind'>,
  accounted: { through: number; settled: RequestMark | null }
): Pick<AgentSessionTurnCompletion, 'mergedTurnCount' | 'mergedAnsweredTurnIds'> {
  const behind = state.turnsBehind
  const unaccounted = (behind?.turns ?? []).filter(
    (turn) => turn.sequence > accounted.through && turn.id !== accounted.settled?.id
  )
  if (behind?.more && unaccounted.length === behind.turns.length) {
    return { mergedTurnCount: behind.turns.length + 1 }
  }
  const answered = unaccounted.filter((turn) => turn.answered).map((turn) => turn.id)
  return answered.length > 0
    ? { mergedTurnCount: answered.length + 1, mergedAnsweredTurnIds: answered }
    : {}
}
