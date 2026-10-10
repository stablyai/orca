// What the journal answers about its Stops beyond the queue's pause: the latest Stop event, which
// the turn-end rule reads (`journal-stop-turn-end.ts`), whether a person's still decides, and what
// a person's Stop that named no turn binds while and after it settles.

import type { JournalReducerState } from './journal-reducer'
import {
  beginJournalStopSettle,
  latestAcceptedSendUnopened,
  personStopDecidesTurn,
  type JournalLatestStop
} from './journal-stop-turn-end'
import type { JournalStopFailedOn, JournalStopSettle } from './queued-message-pause'

export class JournalStopMarks {
  // Bumped on each settle edge: readers cached per commit see an edge that wrote no row.
  private settleRevision = 0
  private onSettleEdge: (() => void) | null = null

  constructor(private readonly deps: { state: () => JournalReducerState }) {}

  /** Told of each settle edge, which writes no row, so it is no commit: it moves only what reads
   *  the settle. One listener: a later call replaces it. It must not throw. */
  observeSettleEdges(listener: () => void): void {
    this.onSettleEdge = listener
  }

  latest(): JournalLatestStop | null {
    return this.deps.state().queuePauseMarks.latestStop
  }

  /** Changes whenever a settle opens or closes. */
  revision(): number {
    return this.settleRevision
  }

  /** `latestAcceptedSendUnopened`: the latest accepted send's turn row may still be on its way. */
  latestAcceptedSendUnopened(): boolean {
    return latestAcceptedSendUnopened(this.deps.state())
  }

  /** `personStopDecidesTurn`: a person's Stop decides how turn `turnId` ends. */
  personStopDecides(turnId: string | null, endedAt?: number): boolean {
    return personStopDecidesTurn(this.deps.state(), turnId, endedAt)
  }

  /** `beginJournalStopSettle`: a turn that ends from here until `settled` is the Stop's. */
  beginSettle(): JournalStopSettle | null {
    const settle = beginJournalStopSettle(this.deps.state())
    if (settle) {
      this.edge()
    }
    return settle
  }

  /** Closes a settle `beginSettle` opened, binding `turnId` when the Stop stopped one, or marking
   *  `failedOn` (display only) when it failed to stop that turn. */
  settled(settle: JournalStopSettle | null, turnId?: string, failedOn?: JournalStopFailedOn): void {
    if (!settle) {
      return
    }
    settle.settling = false
    if (turnId !== undefined) {
      settle.turnId = turnId
    } else if (failedOn !== undefined) {
      settle.failedOn = failedOn
    }
    this.edge()
  }

  private edge(): void {
    this.settleRevision += 1
    this.onSettleEdge?.()
  }
}
