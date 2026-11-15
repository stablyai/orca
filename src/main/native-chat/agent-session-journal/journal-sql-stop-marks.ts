import {
  beginJournalStopSettle,
  personStopDecidesTurn,
  type JournalLatestStop
} from './context-epochs/journal-stop-turn-end'
import type {
  JournalStopFailedOn,
  JournalStopSettle
} from './queued-messages/queued-message-pause-marks'
import type { JournalStopSettleFact } from './journal-writer-host-facts'

export type JournalSqlStopReads = {
  latestStop: () => Promise<JournalLatestStop | null>
  latestAcceptedSendUnopened: () => Promise<boolean>
}

/**
 * The latest Stop is read from SQL; its settlement stays host memory, as on the in-memory journal,
 * so a relaunch forgets a session-ending Stop's binding. The overlay names the Stop it settles.
 */
export class SqlJournalStopMarks {
  private settleRevision = 0
  private onSettleEdge: (() => void) | null = null
  private overlay: { sequence: number; settle: JournalStopSettle } | null = null

  constructor(
    private readonly reads: JournalSqlStopReads,
    private readonly ordered: <T>(run: () => Promise<T>) => Promise<T>
  ) {}

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

  async latest(): Promise<JournalLatestStop | null> {
    return this.withCurrentSettlement(await this.reads.latestStop())
  }

  withCurrentSettlement(stop: JournalLatestStop | null): JournalLatestStop | null {
    if (!stop) {
      return null
    }
    const { settle: _stored, ...saved } = stop
    return this.overlay?.sequence === stop.sequence
      ? { ...saved, settle: { ...this.overlay.settle } }
      : saved
  }

  /** The settlement every writer command plans with; the writer applies it only to its own Stop. */
  fact(): JournalStopSettleFact | undefined {
    return this.overlay
      ? { sequence: this.overlay.sequence, settle: { ...this.overlay.settle } }
      : undefined
  }

  revision(): number {
    return this.settleRevision
  }

  latestAcceptedSendUnopened(): Promise<boolean> {
    return this.reads.latestAcceptedSendUnopened()
  }

  async personStopDecides(turnId: string | null, endedAt?: number): Promise<boolean> {
    const latestStop = await this.latest()
    return personStopDecidesTurn(stopState(latestStop), turnId, endedAt)
  }

  /** Until settled, session-ending Stops own every turn ending during settlement. */
  beginSettle(endsSession = false): Promise<JournalStopSettle | null> {
    return this.ordered(async () => {
      const latestStop = await this.latest()
      if (!latestStop) {
        return null
      }
      const settle = beginJournalStopSettle(stopState(latestStop), endsSession)
      if (settle) {
        this.overlay = { sequence: latestStop.sequence, settle }
        this.edge()
      }
      return settle
    })
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

/** The shared Stop rules read only `queuePauseMarks.latestStop` from the state they are given. */
function stopState(
  latestStop: JournalLatestStop | null
): Parameters<typeof personStopDecidesTurn>[0] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both Stop rules read queuePauseMarks.latestStop only.
  return { queuePauseMarks: { latestStop } } as Parameters<typeof personStopDecidesTurn>[0]
}
