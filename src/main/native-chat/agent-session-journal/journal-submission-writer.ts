// A sent message's rows: its write-ahead submission and each dispatch transition, with what must
// commit in the same transaction (a queued card's hand-off, the send's ledger answer, a kept card).

import type {
  AgentJournalCursor,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { journalDispatchRowApplies } from './journal-dispatch-settlement'
import type { JournalQueuedMessages, JournalQueuePlan } from './journal-queued-messages'
import type { JournalAttachmentClaim } from './journal-submission-hook'
import type { JournalReducerState } from './journal-reducer'
import { journalDispatchRowBuilder, journalSubmissionRowBuilder } from './journal-row-builders'
import type { JournalRow } from './journal-row-schema'
import type { JournalOperationReceipt, JournalRowWriter } from './journal-row-writer'
import type {
  JournalSubmissionConsume,
  JournalSubmissionInput,
  ResolveDispatchInput
} from './journal-store-contracts'

export type JournalSubmissionWriterDeps = {
  state: () => JournalReducerState
  identity: AgentSessionJournalIdentity
  rowWriter: JournalRowWriter
  queuedMessages: JournalQueuedMessages
  claimAttachments: JournalAttachmentClaim
}

export class JournalSubmissionWriter {
  constructor(private readonly deps: JournalSubmissionWriterDeps) {}

  /**
   * Write-ahead submission row. It is durable before the caller dispatches
   * anything, and it doubles as the optimistic user bubble so an accepted echo
   * reconciles into an existing slot instead of appending a second copy.
   */
  append(
    input: JournalSubmissionInput,
    /** Present: this submission hands off a queued card. The row naming it IS the hand-off, checked
     *  against the card at its turn on the lane: one id, one delivery. */
    consume?: JournalSubmissionConsume,
    /** The send's ledger answer, committed with this row. */
    receipt?: JournalOperationReceipt
  ): Promise<AgentJournalCursor> {
    const { claimAttachments, identity, queuedMessages, rowWriter, state } = this.deps
    const submission = journalSubmissionRowBuilder(state, identity, input, consume)
    let card: JournalQueuePlan | undefined
    return rowWriter
      .enqueueRows(
        () => {
          if (!consume) {
            return [submission]
          }
          queuedMessages.assertConsumable({
            ...consume,
            consumedAs: input.clientMessageId,
            fingerprint: input.payloadFingerprint
          })
          // A card an earlier build wrote moves into the journal with its hand-off.
          card = queuedMessages.plan([{ messageId: consume.messageId }])
          return [...card.rows, submission]
        },
        {
          write: (db, row) => {
            card?.receipt.write(db)
            // A client's new message must name only attachments still stored; a card's were
            // claimed when it was queued.
            claimAttachments(db, input.body, input.origin === 'client' && !consume)
            receipt?.write(db, row)
          },
          committed: () => {
            card?.receipt.committed()
            receipt?.committed()
          }
        },
        (rows) => rows.at(-1)
      )
      .then(rowCursor)
  }

  /**
   * Record a dispatch transition, including a proven retry returning to pending.
   *
   * Accepting REQUIRES the provider identity rather than a free-form id: the
   * adopted key is what the provider's echo will upsert into, so a mismatched
   * string here would silently give the user a second copy of their own message.
   * `cards` commit with the row, or roll it back by throwing.
   */
  resolveDispatch(
    input: ResolveDispatchInput,
    /** Card rows that commit with this one, planned at its turn on the lane. */
    cards?: () => JournalQueuePlan
  ): Promise<AgentJournalCursor> {
    const dispatch = journalDispatchRowBuilder(this.deps.state, input)
    if (!cards) {
      return this.deps.rowWriter.append(dispatch)
    }
    let planned: JournalQueuePlan | undefined
    return this.deps.rowWriter
      .enqueueRows(
        () => {
          planned = cards()
          return [dispatch, ...planned.rows]
        },
        {
          write: (db) => planned?.receipt.write(db),
          committed: () => planned?.receipt.committed()
        },
        (rows) => rows[0]
      )
      .then((rows) => rowCursor(rows.slice(0, 1)))
  }

  /** A provider's late receipt, decided at its turn in the queue: a send a write ahead of it
   *  already settled gets no row, so repeated receipts save and publish once. */
  async acceptLate(input: Extract<ResolveDispatchInput, { state: 'accepted' }>): Promise<void> {
    const { rowWriter, state } = this.deps
    await rowWriter.enqueueRows(() =>
      journalDispatchRowApplies(state().submissions.get(input.clientMessageId))
        ? [journalDispatchRowBuilder(state, input)]
        : []
    )
  }
}

/** Where the last of the rows landed: the submission, or the dispatch row. */
function rowCursor(rows: readonly JournalRow[]): AgentJournalCursor {
  const row = rows.at(-1)
  if (!row) {
    throw new Error('agent_session_journal_row_unwritten')
  }
  return { epoch: row.epoch, sequence: row.seq }
}
