// A person's Stop accepted in ONE transaction: every send it holds, its Stop event, and the
// command receipt that names that event. Nothing of it is durable unless all of it is, so a Stop
// whose acceptance fails holds nothing, records nothing and interrupts nothing.

import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { JournalReducerState } from './journal-reducer'
import { journalDispatchRowBuilder } from './journal-row-builders'
import type { JournalStopEvent } from './journal-row-schema'
import type { JournalOperationReceipt, JournalRowWriter } from './journal-row-writer'
import { journalStopEventRowBuilder } from './journal-stop-and-resume-rows'
import type { AgentSessionJournal } from './journal-store'
import { planUnsentSendSettlements } from './journal-unsent-send-hold'
import type { JournalHostDatabase } from './journal-host-database'
import { assertJournalWritable } from './journal-write-guards'
import type { JournalWriteBody } from './journal-write-queue'

export type JournalStopAcceptanceInput = {
  /** `accepted.cutoff` is the journal's position at this write's turn in the queue. */
  event: Omit<JournalStopEvent, 'at' | 'accepted'> & {
    accepted: Omit<NonNullable<JournalStopEvent['accepted']>, 'cutoff'>
  }
  fence: number
  hostInstance: string
  /** Hold every send accepted and never handed over: a person's message becomes a held card. */
  holdQueued: boolean
}

export type JournalStopAcceptance = {
  /** Where the Stop event landed. */
  mark: AgentJournalCursor
  /** The sends it held, by client message id. */
  held: string[]
}

const RETURNED = agentSessionFailureWords(agentSessionFailureFact('returnedToQueue'), {
  surface: 'rejection'
})
const WITHDRAWN = agentSessionFailureWords(agentSessionFailureFact('cancelled'), {
  surface: 'rejection'
})

export class JournalStopAcceptor {
  constructor(
    private readonly deps: {
      sessionId: string
      journal: () => AgentSessionJournal
      writer: Pick<JournalRowWriter, 'enqueuePlannedRows'>
      state: () => JournalReducerState
      serialize: <T>(run: JournalWriteBody<T>) => Promise<T>
      database: () => JournalHostDatabase
      readOnly: () => boolean
    }
  ) {}

  /** What the Stop holds, its event and `receipt`, in one transaction at its turn in the queue. */
  async accept(
    input: JournalStopAcceptanceInput,
    receipt?: JournalOperationReceipt
  ): Promise<JournalStopAcceptance> {
    const { state } = this.deps
    const journal = this.deps.journal()
    let held: string[] = []
    const rows = await this.deps.writer.enqueuePlannedRows(
      () => {
        const cutoff = state().lastSequence
        const queued = input.holdQueued
          ? journal.submissions().filter(isQueuedAgentJournalSubmission)
          : []
        held = queued.map((entry) => entry.clientMessageId)
        // A send no card can carry (an image, a command, another agent's message) is withdrawn,
        // as before; a card's own hand-off returns its card to waiting.
        const settlements = planUnsentSendSettlements(journal, queued, {
          fence: input.fence,
          hostInstance: input.hostInstance,
          rejection: (kept) => (kept ? RETURNED : WITHDRAWN)
        })
        const event = { ...input.event, accepted: { ...input.event.accepted, cutoff } }
        return [
          ...settlements.map(({ reject, kept, keep }) => ({
            build: journalDispatchRowBuilder(state, kept ?? reject),
            ...(keep ? { hook: keep } : {})
          })),
          { build: journalStopEventRowBuilder(state, event, input.fence) }
        ]
      },
      receipt,
      (written) => written.at(-1)
    )
    const mark = rows.at(-1)
    if (!mark) {
      throw new Error('an accepted Stop requires its Stop event')
    }
    return { mark: { epoch: mark.epoch, sequence: mark.seq }, held }
  }

  /** `receipt` committed alone, in order with this chat's writes: an acceptance writing no row. */
  commitReceipt(receipt: JournalOperationReceipt): Promise<void> {
    return this.deps.serialize(() => {
      assertJournalWritable(this.deps.readOnly(), this.deps.sessionId)
      this.deps.database().transaction((db) => receipt.write(db))
      receipt.committed()
    })
  }
}
