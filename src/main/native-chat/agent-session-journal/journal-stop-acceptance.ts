// A person's Stop accepted in ONE transaction: the withdrawal of every send still queued, its Stop
// event, and the command receipt that names that event. Nothing of it is durable unless all of it
// is, so a Stop whose acceptance fails withdraws nothing and interrupts nothing.

import type { AgentJournalDispatchRejection } from '../../../shared/agent-session-failure-words'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import { journalQueuedRejectionRowBuilders } from './journal-pending-submission-recovery'
import type { JournalReducerState } from './journal-reducer'
import type { JournalStopEvent } from './journal-row-schema'
import type { JournalOperationReceipt, JournalRowWriter } from './journal-row-writer'
import { journalStopEventRowBuilder } from './journal-stop-and-resume-rows'

export type JournalStopAcceptanceInput = {
  event: Omit<JournalStopEvent, 'at'>
  fence: number
  /** What every queued send is rejected with. */
  withdrawal: AgentJournalDispatchRejection
}

export type JournalStopAcceptance = {
  /** Where the Stop event landed. */
  mark: AgentJournalCursor
  /** The sends it withdrew, by client message id. */
  withdrawn: string[]
}

export class JournalStopAcceptor {
  constructor(
    private readonly deps: {
      writer: Pick<JournalRowWriter, 'enqueueRows'>
      state: () => JournalReducerState
    }
  ) {}

  /** Whether a tombstone removed turn `turnId`'s record, as a rewind does: over, for a Stop. */
  turnWasRemoved(turnId: string): boolean {
    return this.deps.state().removedTurnIds.has(turnId)
  }

  /** The withdrawal, the event and `receipt`, in one transaction at its turn in the queue. */
  async accept(
    input: JournalStopAcceptanceInput,
    receipt?: JournalOperationReceipt
  ): Promise<JournalStopAcceptance> {
    const { state } = this.deps
    const rows = await this.deps.writer.enqueueRows(
      // The same rows the chat's queued withdrawal always wrote, then the event.
      () => [
        ...journalQueuedRejectionRowBuilders(state, input.fence, input.withdrawal),
        journalStopEventRowBuilder(state, input.event, input.fence)
      ],
      receipt,
      (written) => written.at(-1)
    )
    const mark = rows.at(-1)
    if (!mark) {
      throw new Error('an accepted Stop requires its Stop event')
    }
    const withdrawn = rows.flatMap((row) => (row.kind === 'dispatch' ? [row.clientMessageId] : []))
    return { mark: { epoch: mark.epoch, sequence: mark.seq }, withdrawn }
  }
}
