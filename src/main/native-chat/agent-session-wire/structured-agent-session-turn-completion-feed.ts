// The host's answer to "a turn just finished", derived once per journal commit.
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

import { isStructuredAgentSessionCommandTurn } from '../../../shared/structured-agent-session-command-entry'
import type { AgentJournalTurnLifecycle } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { readAgentJournalTurnOutcome } from '../../../shared/agent-session-turn-record'
import type {
  AgentSessionTurnCompletion,
  AgentSessionTurnCompletionEvent
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export type StructuredAgentSessionTurnCompletionSubscriber = {
  id: string
  emit: (event: AgentSessionTurnCompletionEvent) => void
}

/** Only the newest-turn reader and cursor are needed here; asking for the whole journal would overstate it. */
type CompletionFeedCursor = { epoch: string; sequence: number }

type CompletionFeedJournal = Pick<AgentSessionJournal, 'newestTurn' | 'cursor' | 'itemBody'>

type CompletionFeedSession = {
  journal: CompletionFeedJournal
  params: { location: AgentSessionRecord['location'] }
}

export type StructuredAgentSessionTurnCompletionFeedDeps = {
  sessions: ReadonlyMap<string, CompletionFeedSession>
  now: () => number
}

/** Per-session baseline. `settledTurnId` is the last settled turn this feed has accounted for;
 *  absence of the whole entry — not a null field — is what makes the first observation silent. */
type SessionBaseline = CompletionFeedCursor & { settledTurnId: string | null }

function isSettled(turn: AgentJournalTurnLifecycle | null): turn is AgentJournalTurnLifecycle {
  return turn !== null && turn.state !== 'running'
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
   * settled turn this feed has not already accounted for.
   *
   * The first observation of a session only records where it is, so restore, restart, rewind and
   * a re-read of history all pass through silently. An already-settled turn republished by an
   * in-place revision carries the same turn id and so cannot fire twice.
   */
  observe(sessionId: string, journal?: CompletionFeedJournal): void {
    const session = this.deps.sessions.get(sessionId)
    if (!session) {
      return
    }
    const source = journal ?? session.journal
    const cursor = source.cursor()
    const turn = source.newestTurn()
    const settled = isSettled(turn) ? turn : null
    const baseline = this.baselines.get(sessionId)
    if (!baseline) {
      // Baseline only. Whatever the session was already holding is history, not news.
      this.baselines.set(sessionId, {
        epoch: cursor.epoch,
        sequence: cursor.sequence,
        settledTurnId: settled?.turnId ?? null
      })
      return
    }
    if (baseline.epoch !== cursor.epoch || cursor.sequence < baseline.sequence) {
      // Epoch replacement (rewind, repair, or legacy import) republishes history with a new
      // identity. It is not a provider edge, so re-baseline silently instead of announcing the
      // newest settled row as a fresh completion.
      baseline.epoch = cursor.epoch
      baseline.sequence = cursor.sequence
      baseline.settledTurnId = settled?.turnId ?? null
      return
    }
    baseline.sequence = cursor.sequence
    // A conversation command is no request of the user's: it neither announces nor moves the mark
    // off the last real turn.
    if (isStructuredAgentSessionCommandTurn(turn, source.itemBody)) {
      return
    }
    if (!settled) {
      // A running turn clears the mark, so this detector fires on each running → settled
      // transition rather than on an id it happens not to have seen.
      baseline.settledTurnId = null
      return
    }
    if (baseline.settledTurnId === settled.turnId) {
      return
    }
    baseline.settledTurnId = settled.turnId
    // ABSENT OUTCOME IS UNKNOWN: a turn the host only saw stop carries no verdict and gets no
    // event. Inferring success here is the one mistake that would light the dot on a failure.
    const outcome = readAgentJournalTurnOutcome(settled)
    if (!outcome) {
      return
    }
    this.broadcast({
      type: 'completion',
      completion: {
        scope: session.params.location,
        sessionId,
        turnId: settled.turnId,
        outcome,
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
