// A person's Stop accepted in ONE transaction: the send it stops, every send queued behind it, its
// Stop event, and the command receipt that names that event. Nothing of it is durable unless all of
// it is, so a Stop whose acceptance fails withdraws nothing, holds nothing and interrupts nothing.

import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionFailureWordsContext } from '../../../shared/agent-session-failure-words'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { JournalReducerState } from './journal-reducer'
import { journalDispatchRowBuilder } from './journal-row-builders'
import type { JournalStopEvent } from './journal-row-schema'
import type {
  JournalOperationReceipt,
  JournalPlannedRow,
  JournalRowWriter
} from './journal-row-writer'
import { journalStopEventRowBuilder } from './journal-stop-and-resume-rows'
import type { AgentSessionJournal } from './journal-store'
import {
  isUnansweredHandedOverSubmission,
  planUnsentSendSettlements,
  userStopRejection
} from './journal-unsent-send-hold'

export type JournalStopAcceptanceInput = {
  event: Omit<JournalStopEvent, 'at'>
  fence: number
  hostInstance: string
  /** Who the words of a held send name. */
  words: AgentSessionFailureWordsContext
}

export type JournalStopAcceptance = {
  /** Where the Stop event landed. */
  mark: AgentJournalCursor
  /** The sends it withdrew or held, by client message id. */
  settled: string[]
}

export class JournalStopAcceptor {
  constructor(
    private readonly deps: {
      journal: () => AgentSessionJournal
      writer: Pick<JournalRowWriter, 'enqueuePlannedRows'>
      state: () => JournalReducerState
    }
  ) {}

  /** What the Stop settles, its event and `receipt`, in one transaction at its turn in the queue. */
  async accept(
    input: JournalStopAcceptanceInput,
    receipt?: JournalOperationReceipt
  ): Promise<JournalStopAcceptance> {
    const { state } = this.deps
    const journal = this.deps.journal()
    let settled: string[] = []
    const rows = await this.deps.writer.enqueuePlannedRows(
      () => {
        const queued = journal
          .submissions()
          .filter(isQueuedAgentJournalSubmission)
          .sort((a, b) => (a.acceptedSequence ?? 0) - (b.acceptedSequence ?? 0))
        settled = queued.map((entry) => entry.clientMessageId)
        // With nothing running or handed over, the first queued send is what the Stop stops: it is
        // withdrawn, as the turn it would have opened. The sends behind it are held.
        const ahead =
          journal.activeTurnId() !== null ||
          journal.submissions().some(isUnansweredHandedOverSubmission)
        const stopped = ahead ? undefined : queued[0]
        const behind = stopped ? queued.slice(1) : queued
        const settlement = { fence: input.fence, hostInstance: input.hostInstance }
        const withdrawn = stopped
          ? planUnsentSendSettlements(journal, [stopped], {
              ...settlement,
              rejection: () => userStopRejection(false, input.words)
            })
          : []
        // TEMPORARY: a send no card can carry (an image, a command, another agent's message) is
        // withdrawn until queued cards hold attachments, commands and agent messages, so Stop can
        // hold them too.
        const held = planUnsentSendSettlements(journal, behind, {
          ...settlement,
          rejection: (kept) => userStopRejection(kept, input.words)
        })
        const planned: JournalPlannedRow[] = [
          // No card: a card's own hand-off still returns that card, as any refusal of it does.
          ...withdrawn.map(({ reject }) => ({ build: journalDispatchRowBuilder(state, reject) })),
          ...held.map(({ reject, kept, keep }) => ({
            build: journalDispatchRowBuilder(state, kept ?? reject),
            ...(keep ? { hook: keep } : {})
          })),
          { build: journalStopEventRowBuilder(state, input.event, input.fence) }
        ]
        return planned
      },
      receipt,
      (written) => written.at(-1)
    )
    const mark = rows.at(-1)
    if (!mark) {
      throw new Error('an accepted Stop requires its Stop event')
    }
    return { mark: { epoch: mark.epoch, sequence: mark.seq }, settled }
  }
}
