// The host's answer to "a request just finished" and "the agent just asked the user something",
// derived once per journal commit. A request is the one the status row reports: a turn, or a send
// the agent or its start refused. A prompt is an approval or question item left pending; it
// usually lands mid-turn, so it is its own edge rather than a kind of completion.
//
// WHY THE HOST DERIVES IT: a structured session runs on the execution host and keeps journalling
// whether or not any renderer has a reader mounted. A client that derived completions itself would
// see none for a backgrounded chat — which is the case this exists to serve.
//
// WHY IT IS LIVE-ONLY: nothing here is retained, replayed or queued. A subscriber learns what
// finishes or asks while it is subscribed and nothing else. That is the deliberate opposite of the status
// feed next door, which replays every session on subscribe: a status is state a late reader still
// needs, a completion is an edge that has already passed. Keeping a queue would create a durable
// obligation with nothing to retire it.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionTurnCompletion,
  AgentSessionTurnCompletionEvent
} from '../../../shared/agent-session-wire'
import type {
  AgentSessionAttentionEdge,
  StructuredAttentionState
} from '../../../shared/agent-session-attention'
import type { StructuredAgentSessionLatestRequest } from '../../../shared/structured-agent-session-latest-request'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionStatusState } from './structured-agent-session-status-feed'

export type StructuredAgentSessionTurnCompletionSubscriber = {
  id: string
  emit: (event: AgentSessionTurnCompletionEvent) => void
  /** Opted in to `prompt` events; a client that predates them would misread the arm. */
  includePrompts?: boolean
  /** In-process only: pending prompts for delivery reconciliation, on restore and when one ends. */
  onState?: (state: StructuredAttentionState) => void
}

type CompletionFeedCursor = { epoch: string; sequence: number }

type CompletionFeedSession = {
  journal: Pick<AgentSessionJournal, 'cursor'>
  params: { location: AgentSessionRecord['location'] }
}

export type StructuredAgentSessionTurnCompletionFeedDeps = {
  sessions: ReadonlyMap<string, CompletionFeedSession>
  now: () => number
  /** The status feed's projection for this commit, so the event follows the request its row reports. */
  readStatusState: (
    sessionId: string,
    journal?: AgentSessionJournal
  ) => StructuredAgentSessionStatusState | null
}

type RequestMark = Pick<StructuredAgentSessionLatestRequest, 'kind' | 'id'>

/** Per-session baseline. `settled` is the last settled request this feed has accounted for and
 *  `prompts` the prompts already pending; absence of the whole entry — not an empty field — is
 *  what makes the first observation silent. */
type SessionBaseline = CompletionFeedCursor & {
  settled: RequestMark | null
  prompts: ReadonlySet<string>
}

function settledMark(request: StructuredAgentSessionLatestRequest | null): RequestMark | null {
  return request && request.turnState !== 'running' ? { kind: request.kind, id: request.id } : null
}

export class StructuredAgentSessionTurnCompletionFeed {
  private readonly subscribers = new Map<string, StructuredAgentSessionTurnCompletionSubscriber>()
  private readonly baselines = new Map<string, SessionBaseline>()

  constructor(private readonly deps: StructuredAgentSessionTurnCompletionFeedDeps) {}

  /** No snapshot arm, by decision: see the file header. A subscriber starts empty. */
  subscribe(subscriber: StructuredAgentSessionTurnCompletionSubscriber): () => void {
    this.subscribers.set(subscriber.id, subscriber)
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

  /** The session is no longer held here, so its baseline must go with it — a re-attached session
   *  baselines again rather than re-announcing the turn it was already holding. */
  forget(sessionId: string): void {
    this.baselines.delete(sessionId)
  }

  /**
   * One journal publication, at most one event per subscriber. A new prompt keeps its own identity
   * beside a clean completion, so answering it retires its alert. That completion reaches only
   * completion-only subscribers; a failure remains distinct news for everyone.
   *
   * The first observation of a session only records where it is, so restore, restart, rewind and
   * a re-read of history all pass through silently. An already-settled request republished by an
   * in-place revision carries the same identity and so cannot fire twice; nor can a prompt.
   */
  observe(
    sessionId: string,
    journal?: AgentSessionJournal,
    options?: { historical?: boolean }
  ): void {
    const session = this.deps.sessions.get(sessionId)
    const state = session ? this.deps.readStatusState(sessionId, journal) : null
    if (!session || !state) {
      return
    }
    const cursor = (journal ?? session.journal).cursor()
    const request = state.latestRequest
    const prompts = new Set(state.pendingPromptIds)
    const baseline = this.baselines.get(sessionId)
    // Only a restore or a prompt leaving the set can strand a delivered alert.
    if (!baseline || options?.historical || [...baseline.prompts].some((id) => !prompts.has(id))) {
      this.publishState(session, sessionId, state.pendingPromptIds)
    }
    if (!baseline || options?.historical) {
      // Baseline only. Whatever the session was already holding is history, not news.
      this.baselines.set(sessionId, { ...cursor, settled: settledMark(request), prompts })
      return
    }
    if (baseline.epoch !== cursor.epoch || cursor.sequence < baseline.sequence) {
      // Epoch replacement (rewind or legacy import) republishes history with a new
      // identity. It is not a provider edge, so re-baseline silently instead of announcing the
      // newest settled row as a fresh completion.
      baseline.epoch = cursor.epoch
      baseline.sequence = cursor.sequence
      baseline.settled = settledMark(request)
      baseline.prompts = prompts
      return
    }
    baseline.sequence = cursor.sequence
    // An answered prompt leaves the set, so only a prompt not pending last commit is news.
    const raised = state.pendingPromptIds.find((id) => !baseline.prompts.has(id))
    baseline.prompts = prompts
    const completion = this.settledCompletion(sessionId, session, state, baseline)
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

  /** The completion this commit settles, if any. */
  private settledCompletion(
    sessionId: string,
    session: CompletionFeedSession,
    state: StructuredAgentSessionStatusState,
    baseline: SessionBaseline
  ): AgentSessionTurnCompletion | null {
    const request = state.latestRequest
    if (request?.turnState === 'running') {
      // A running turn clears the mark, so this detector fires on each running → settled
      // transition rather than on an id it happens not to have seen.
      baseline.settled = null
      return null
    }
    // Owed work waits, so sends refused one commit at a time announce once, when the last is
    // answered. A pending prompt does not wait: the event says so itself, and answering it keeps
    // the same identity.
    // A withdrawn send leaves the older request latest.
    if (
      state.owesWork ||
      !request ||
      (baseline.settled?.kind === request.kind && baseline.settled.id === request.id)
    ) {
      return null
    }
    baseline.settled = settledMark(request)
    // ABSENT OUTCOME IS UNKNOWN: a turn the host only saw stop carries no verdict and gets no
    // event. Inferring success here is the one mistake that would light the dot on a failure.
    if (!request.outcome) {
      return null
    }
    return {
      scope: session.params.location,
      sessionId,
      turnId: request.id,
      outcome: request.outcome,
      completedAt: this.deps.now(),
      // Stated here, not joined from the status stream: remote clients receive the two unordered.
      ...(state.summary.status === 'attention' ? { awaitingUser: true as const } : {})
    }
  }

  private broadcast(
    event: AgentSessionAttentionEdge,
    audience: 'all' | 'legacy' | 'prompt-aware'
  ): void {
    // A Map skips entries deleted mid-iteration, so a failing subscriber can drop itself here.
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
