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
import type { JournalStopSettle } from './queued-message-pause'

export class JournalStopMarks {
  constructor(private readonly deps: { state: () => JournalReducerState }) {}

  latest(): JournalLatestStop | null {
    return this.deps.state().queuePauseMarks.latestStop
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
    return beginJournalStopSettle(this.deps.state())
  }

  /** Closes a settle `beginSettle` opened, binding `turnId` when the Stop stopped one. */
  settled(settle: JournalStopSettle | null, turnId?: string): void {
    if (!settle) {
      return
    }
    settle.settling = false
    if (turnId !== undefined) {
      settle.turnId = turnId
    }
  }
}
