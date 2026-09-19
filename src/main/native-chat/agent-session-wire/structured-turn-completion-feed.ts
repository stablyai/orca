// The host's answer to "did a structured chat's root turn just finish, and did it go well".
//
// Derived here rather than in a renderer because the host owns journal commit and is the only
// party that can observe a session whose chat is not mounted — which is the whole case the
// indicators exist for. The verdict is A0's recorded `outcome`, read off the journal turn record;
// nothing here re-derives success from lifecycle state, because `completed` is also what the host
// writes for a turn the provider ended with an API error.
//
// RECOVERY IS LIVE-ONLY, BY DECISION. Nothing is persisted and nothing is queued, so nothing can
// strand — that is the reason for the choice. Two rules implement it, and both are pinned by
// tests because a later refactor turning either into catch-up would be silent:
//
//   1. A session BASELINES on the first edge that reaches this feed. Whatever terminal turn the
//      journal already holds is recorded as accounted for and announced to nobody. A restored,
//      rewound or restarted session is not a completing session.
//   2. A subscriber arrives to nothing. Unlike the status feed there is no opening snapshot, so a
//      completion that happened while no client was connected is dropped rather than replayed.
//
// Only the journal-commit edge can announce anything. Every other publication edge — handoff,
// lease renewal, background-task ticks, restore — may only baseline a session it has never seen,
// never advance one it has. That asymmetry is what stops a status tick that happens to interleave
// with a commit from silently absorbing the completion it was not looking at.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentJournalTurnLifecycle } from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurnOutcome } from '../../../shared/agent-session-turn-record'
import { newestStructuredAgentSessionTurn } from '../../../shared/structured-agent-session-projection'
import type { StructuredTurnCompletionEvent } from '../../../shared/structured-turn-completion'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export type StructuredTurnCompletionSubscriber = {
  id: string
  emit: (event: StructuredTurnCompletionEvent) => void
}

type CompletionFeedSession = {
  journal: AgentSessionJournal
  params: { location: AgentSessionRecord['location'] }
}

export type StructuredTurnCompletionFeedDeps = {
  sessions: ReadonlyMap<string, CompletionFeedSession>
  now: () => number
}

/**
 * How many of a session's terminal turn ids stay accounted for.
 *
 * The set is what makes a re-publication of the same journal — an event-recovery snapshot, a
 * rewind that leaves an older terminal turn newest — silent. Evicting the oldest entries only
 * risks re-announcing a turn that was already announced this session and has since been rewound
 * past this many turns, which no real session reaches. Bounded because the alternative is a map
 * that grows for the life of a long chat.
 */
const MAX_ACCOUNTED_TURNS = 128

export class StructuredTurnCompletionFeed {
  private readonly subscribers = new Map<string, StructuredTurnCompletionSubscriber>()
  private readonly accountedBySession = new Map<string, Set<string>>()

  constructor(private readonly deps: StructuredTurnCompletionFeedDeps) {}

  /** Live only: a subscriber gets no snapshot, so it hears completions from now on and no earlier. */
  subscribe(subscriber: StructuredTurnCompletionSubscriber): () => void {
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

  /**
   * Record where a session already is without announcing it.
   *
   * Every non-commit publication edge calls this, which is what gives an attaching or restoring
   * session its baseline. It never advances a session this feed already knows, so it cannot
   * absorb a completion that the commit edge has not reported yet.
   */
  baseline(sessionId: string): void {
    if (this.accountedBySession.has(sessionId)) {
      return
    }
    this.observe(sessionId)
  }

  /** The session is gone; its turn bookkeeping goes with it. */
  forget(sessionId: string): void {
    this.accountedBySession.delete(sessionId)
  }

  /** The journal-commit edge: the only one that can announce a completion. */
  observe(sessionId: string, journal?: AgentSessionJournal): void {
    const session = this.deps.sessions.get(sessionId)
    if (!session) {
      return
    }
    const accounted = this.accountedBySession.get(sessionId)
    const turn = this.newestTerminalTurn(journal ?? session.journal)
    if (!accounted) {
      // First sight of this session. Whatever it already finished happened before we were
      // watching, so it is accounted for and announced to nobody.
      this.accountedBySession.set(sessionId, new Set(turn ? [turn.turnId] : []))
      return
    }
    if (!turn || accounted.has(turn.turnId)) {
      return
    }
    this.account(accounted, turn.turnId)
    const outcome = readAgentJournalTurnOutcome(turn)
    if (!outcome) {
      // Unknown is not a completion: an older host, an end the host inferred rather than heard,
      // or a verdict this build cannot place. Accounted for above so it is asked once.
      return
    }
    this.broadcast({
      type: 'completion',
      completion: {
        scope: session.params.location,
        sessionId,
        turnId: turn.turnId,
        outcome,
        completedAt: turn.completedAt ?? this.deps.now()
      }
    })
  }

  /** The newest ROOT turn once it has stopped running. Child turns write no turn record at all,
   *  so reading the journal's own turn item is already root-only. */
  private newestTerminalTurn(journal: AgentSessionJournal): AgentJournalTurnLifecycle | null {
    if (journal.isReadOnly) {
      return null
    }
    const turn = newestStructuredAgentSessionTurn(journal.snapshot().items)
    return turn && turn.state !== 'running' ? turn : null
  }

  private account(accounted: Set<string>, turnId: string): void {
    accounted.add(turnId)
    while (accounted.size > MAX_ACCOUNTED_TURNS) {
      const oldest = accounted.values().next()
      if (oldest.done) {
        return
      }
      accounted.delete(oldest.value)
    }
  }

  private broadcast(event: StructuredTurnCompletionEvent): void {
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
