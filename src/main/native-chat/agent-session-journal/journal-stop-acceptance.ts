import type { CaptureSessionMail } from './journal-mail-holds'
import type { JournalRow } from './journal-row-schema'
import type { JournalMailBoundary } from './journal-mail-boundary'
import { composeJournalOperationReceipts } from './journal-row-writer'
// Commit withdrawals, Stop event and receipt atomically; failed acceptance must interrupt nothing.

import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import { journalQueuedRejectionRowBuilders } from './journal-pending-submission-recovery'
import type { JournalReducerState } from './journal-reducer'
import type { JournalStopEvent } from './journal-row-schema'
import type { JournalOperationReceipt, JournalRowWriter } from './journal-row-writer'
import { journalStopEventRowBuilder } from './journal-stop-and-resume-rows'

export type JournalStopAcceptanceInput = {
  captureMailIntent?: boolean
  captureMail?: CaptureSessionMail
  event: Omit<JournalStopEvent, 'at'>
  fence: number
  /** Read the live turn when the event is written. */
  liveTurnId: () => string | null
}

// Host-held sends prove non-delivery.
const STOP_WITHDRAWAL = agentSessionFailureWords(
  agentSessionFailureFact('cancelled', { neverReachedAgent: true }),
  { surface: 'rejection' }
)

export type JournalStopAcceptance = {
  mark: AgentJournalCursor
  withdrawn: string[]
  /** Explicitly named turn, otherwise the turn live at write time. */
  turnId: string | null
}

export class JournalStopAcceptor {
  constructor(
    private readonly deps: {
      writer: Pick<JournalRowWriter, 'enqueueRows'>
      sessionId: string
      state: () => JournalReducerState
    }
  ) {}

  /** Rewound turns count as ended for Stop. */
  turnWasRemoved(turnId: string): boolean {
    return this.deps.state().removedTurnIds.has(turnId)
  }

  async accept(
    input: JournalStopAcceptanceInput,
    receipt?: JournalOperationReceipt
  ): Promise<JournalStopAcceptance> {
    const { state } = this.deps
    let turnId: string | null = null
    let finished: (() => void) | undefined
    const release = () => {
      const done = finished
      finished = undefined
      done?.()
    }
    let rows: JournalRow[]
    try {
      rows = await this.deps.writer.enqueueRows(
        () => {
          turnId = input.event.turnId ?? input.liveTurnId()
          const event = { ...input.event, ...(turnId !== null ? { turnId } : {}) }
          let boundary: JournalMailBoundary | undefined
          if (event.reason === 'user-stop' && input.captureMailIntent !== false) {
            let captured: ReturnType<CaptureSessionMail> = {}
            try {
              captured = input.captureMail?.() ?? {}
              finished = captured.finished
            } catch {
              // Missing source order cannot refuse a person's Stop.
            }
            boundary = {
              version: 2,
              status: 'held',
              stop: null,
              ...(captured.cut ? { cut: captured.cut } : {})
            }
          }
          if (event.reason === 'user-stop' && input.captureMailIntent === false) {
            boundary = state().mailBoundary
          }
          const buildStop = journalStopEventRowBuilder(state, event, input.fence)
          return [
            ...journalQueuedRejectionRowBuilders(state, input.fence, STOP_WITHDRAWAL),
            (seq: number, ts: number) => ({
              ...buildStop(seq, ts),
              ...(boundary
                ? {
                    mailBoundary: {
                      ...boundary,
                      ...(boundary.status === 'held' && input.captureMailIntent !== false
                        ? {
                            stop: {
                              sessionId: this.deps.sessionId,
                              epoch: state().epoch,
                              sequence: seq
                            }
                          }
                        : {})
                    }
                  }
                : {})
            })
          ]
        },
        composeJournalOperationReceipts(...(receipt ? [receipt] : []), {
          write: () => {},
          committed: () => {},
          finished: release
        }),
        (written) => written.at(-1)
      )
    } finally {
      release()
    }
    const mark = rows.at(-1)
    if (!mark) {
      throw new Error('an accepted Stop requires its Stop event')
    }
    const withdrawn = rows.flatMap((row) => (row.kind === 'dispatch' ? [row.clientMessageId] : []))
    return { mark: { epoch: mark.epoch, sequence: mark.seq }, withdrawn, turnId }
  }
}
