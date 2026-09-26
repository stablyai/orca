// The host's answer to "a request just finished", derived once per journal commit. A request is
// the one the status row reports: a turn, or a send the agent or its start refused.
//
// WHY THE HOST DERIVES IT: a structured session runs on the execution host and keeps journalling
// whether or not any renderer has a reader mounted. A client that derived completions itself would
// see none for a backgrounded chat — which is the case this exists to serve.
//
// WHY IT IS LIVE-ONLY: nothing here is retained, replayed or queued. A subscriber learns what
// finishes while it is subscribed and nothing else. That is the deliberate opposite of the status
// feed next door, which replays every session on subscribe: a status is state a late reader still
// needs, a completion is an edge that has already passed. Keeping a queue would create a durable
// obligation with nothing to retire it.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionTurnCompletion,
  AgentSessionTurnCompletionEvent
} from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionLatestRequest } from '../../../shared/structured-agent-session-latest-request'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionStatusState } from './structured-agent-session-status-feed'

export type StructuredAgentSessionTurnCompletionSubscriber = {
  id: string
  emit: (event: AgentSessionTurnCompletionEvent) => void
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

/** Per-session baseline. `settled` is the last settled request this feed has accounted for;
 *  absence of the whole entry — not a null field — is what makes the first observation silent. */
type SessionBaseline = CompletionFeedCursor & { settled: RequestMark | null }

function settledMark(request: StructuredAgentSessionLatestRequest | null): RequestMark | null {
  return request && !request.running ? { kind: request.kind, id: request.id } : null
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
   * One journal publication. Emits at most one completion, and only on the transition into a
   * settled request this feed has not already accounted for.
   *
   * The first observation of a session only records where it is, so restore, restart, rewind and
   * a re-read of history all pass through silently. An already-settled request republished by an
   * in-place revision carries the same identity and so cannot fire twice.
   */
  observe(sessionId: string, journal?: AgentSessionJournal): void {
    const session = this.deps.sessions.get(sessionId)
    const state = session ? this.deps.readStatusState(sessionId, journal) : null
    if (!session || !state) {
      return
    }
    const cursor = (journal ?? session.journal).cursor()
    const request = state.latestRequest
    const baseline = this.baselines.get(sessionId)
    if (!baseline) {
      // Baseline only. Whatever the session was already holding is history, not news.
      this.baselines.set(sessionId, { ...cursor, settled: settledMark(request) })
      return
    }
    if (baseline.epoch !== cursor.epoch || cursor.sequence < baseline.sequence) {
      // Epoch replacement (rewind, repair, or legacy import) republishes history with a new
      // identity. It is not a provider edge, so re-baseline silently instead of announcing the
      // newest settled row as a fresh completion.
      baseline.epoch = cursor.epoch
      baseline.sequence = cursor.sequence
      baseline.settled = settledMark(request)
      return
    }
    baseline.sequence = cursor.sequence
    if (request?.running) {
      // A running turn clears the mark, so this detector fires on each running → settled
      // transition rather than on an id it happens not to have seen.
      baseline.settled = null
      return
    }
    // Only an idle session has a verdict, as on its row: sends refused one commit at a time
    // announce once, when the last is answered. A withdrawn send leaves the older request latest.
    if (
      state.summary.status !== 'idle' ||
      !request ||
      (baseline.settled?.kind === request.kind && baseline.settled.id === request.id)
    ) {
      return
    }
    baseline.settled = settledMark(request)
    // ABSENT OUTCOME IS UNKNOWN: a turn the host only saw stop carries no verdict and gets no
    // event. Inferring success here is the one mistake that would light the dot on a failure.
    if (!request.outcome) {
      return
    }
    this.broadcast({
      type: 'completion',
      completion: {
        scope: session.params.location,
        sessionId,
        turnId: request.id,
        outcome: request.outcome,
        completedAt: this.deps.now()
      }
    })
  }

  private broadcast(event: { type: 'completion'; completion: AgentSessionTurnCompletion }): void {
    // A Map skips entries deleted mid-iteration, so a failing subscriber can drop itself here.
    for (const subscriber of this.subscribers.values()) {
      try {
        subscriber.emit(event)
      } catch {
        this.subscribers.delete(subscriber.id)
      }
    }
  }
}
