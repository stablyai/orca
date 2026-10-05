// What the journal answers about its Stops beyond the queue's pause: the latest Stop event, which
// the turn-end rule reads (`journal-stop-turn-end.ts`), and whether a person's still decides.

import type { JournalReducerState } from './journal-reducer'
import { personStopDecidesTurn, type JournalLatestStop } from './journal-stop-turn-end'

export class JournalStopMarks {
  constructor(private readonly deps: { state: () => JournalReducerState }) {}

  latest(): JournalLatestStop | null {
    return this.deps.state().queuePauseMarks.latestStop
  }

  /** `personStopDecidesTurn`: a person's Stop decides how turn `turnId` ends. */
  personStopDecides(turnId: string | null, endedAt?: number, openedBy?: string): boolean {
    return personStopDecidesTurn(this.deps.state(), turnId, endedAt, openedBy)
  }
}
