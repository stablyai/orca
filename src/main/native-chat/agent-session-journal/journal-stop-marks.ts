import type { JournalReducerState } from './journal-reducer'
import {
  beginJournalStopSettle,
  latestAcceptedSendUnopened,
  personStopDecidesTurn,
  type JournalLatestStop
} from './journal-stop-turn-end'
import type { JournalStopFailedOn, JournalStopSettle } from './queued-message-pause'

export class JournalStopMarks {
  // Settle edges write no row; invalidate readers cached per commit.
  private settleRevision = 0
  private onSettleEdge: (() => void) | null = null

  constructor(private readonly deps: { state: () => JournalReducerState }) {}

  /** One nonthrowing listener, replaced on each call; settle edges do not trigger commits. */
  observeSettleEdges(listener: () => void): () => void {
    const registered = () => listener()
    this.onSettleEdge = registered
    return () => {
      if (this.onSettleEdge === registered) {
        this.onSettleEdge = null
      }
    }
  }

  latest(): JournalLatestStop | null {
    return this.deps.state().queuePauseMarks.latestStop
  }

  revision(): number {
    return this.settleRevision
  }

  latestAcceptedSendUnopened(): boolean {
    return latestAcceptedSendUnopened(this.deps.state())
  }

  personStopDecides(turnId: string | null, endedAt?: number): boolean {
    return personStopDecidesTurn(this.deps.state(), turnId, endedAt)
  }

  /** Until settled, session-ending Stops own every turn ending during settlement. */
  beginSettle(endsSession = false): JournalStopSettle | null {
    const settle = beginJournalStopSettle(this.deps.state(), endsSession)
    if (settle) {
      this.edge()
    }
    return settle
  }

  /** Bind the stopped turn, or retain failedOn solely for display. */
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
