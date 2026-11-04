import type {
  AgentJournalCursor,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { journalDispatchRowApplies } from './journal-dispatch-settlement'
import { journalQueueReopenRowBuilder, journalStopLiftRows } from './journal-stop-and-resume-rows'
import type { JournalQueuedMessages, JournalQueuePlan } from './journal-queued-messages'
import { QueuedMessageNotOwedError } from './queued-message-consume-error'
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
  reopenFloor: () => AgentJournalCursor | null
  identity: AgentSessionJournalIdentity
  rowWriter: JournalRowWriter
  queuedMessages: JournalQueuedMessages
  claimAttachments: JournalAttachmentClaim
}

export class JournalSubmissionWriter {
  constructor(private readonly deps: JournalSubmissionWriterDeps) {}

  /** Persist before dispatch; accepted echoes reuse the optimistic bubble. */
  append(
    input: JournalSubmissionInput,
    /** Validate the linked card on the write lane: one handoff, one delivery. */
    consume?: JournalSubmissionConsume,
    /** Commit the send's ledger answer with the row. */
    receipt?: JournalOperationReceipt
  ): Promise<AgentJournalCursor> {
    const { claimAttachments, identity, queuedMessages, rowWriter, state } = this.deps
    const submission = journalSubmissionRowBuilder(state, identity, input, consume)
    let claimsCommitted: (() => void) | void
    let card: JournalQueuePlan | undefined
    return rowWriter
      .enqueueRows(
        () => {
          const floor = this.deps.reopenFloor()
          const reopen =
            floor?.epoch === state().epoch
              ? [journalQueueReopenRowBuilder(state, input.fence, floor.sequence)]
              : []
          // After the send, so the cards it lifts wait behind it as before. Card Send-now and /compact
          // are the person's too; drained and agents' sends never lift.
          const lift =
            input.origin === 'client' || input.source?.kind === 'user'
              ? journalStopLiftRows(state, input.fence)
              : []
          if (!consume) {
            return [...reopen, submission, ...lift]
          }
          queuedMessages.assertConsumable({
            ...consume,
            consumedAs: input.clientMessageId,
            fingerprint: input.payloadFingerprint
          })
          // Asked on the write lane, so nothing it depends on can change before the handoff row lands.
          const owed = consume.owed?.() ?? 'owed'
          if (owed !== 'owed') {
            throw new QueuedMessageNotOwedError(consume.messageId, owed)
          }
          // Adopt legacy cards in the handoff transaction.
          card = queuedMessages.plan([{ messageId: consume.messageId }])
          return [...reopen, ...card.rows, submission, ...lift]
        },
        {
          write: (db, row) => {
            card?.receipt.write(db)
            // New client sends require stored uploads; queued cards already claimed theirs.
            claimsCommitted = claimAttachments(
              db,
              input.body,
              input.origin === 'client' && !consume
            )
            receipt?.write(db, row)
          },
          committed: () => {
            claimsCommitted?.()
            card?.receipt.committed()
            receipt?.committed()
          }
        },
        (rows) => rows.find(isSubmissionRow)
      )
      .then((rows) => rowCursor(rows.filter(isSubmissionRow)))
  }

  /** Adopt provider identities to prevent duplicate echoes; card changes commit or roll back with the row. */
  resolveDispatch(
    input: ResolveDispatchInput,
    /** Plan card changes on the write lane. */
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

  /** Resolve late receipts on the write lane; settled sends append nothing. */
  async acceptLate(input: Extract<ResolveDispatchInput, { state: 'accepted' }>): Promise<void> {
    const { rowWriter, state } = this.deps
    await rowWriter.enqueueRows(() =>
      journalDispatchRowApplies(state().submissions.get(input.clientMessageId))
        ? [journalDispatchRowBuilder(state, input)]
        : []
    )
  }
}

function isSubmissionRow(row: JournalRow): boolean {
  return row.kind === 'submission'
}

function rowCursor(rows: readonly JournalRow[]): AgentJournalCursor {
  const row = rows.at(-1)
  if (!row) {
    throw new Error('agent_session_journal_row_unwritten')
  }
  return { epoch: row.epoch, sequence: row.seq }
}
