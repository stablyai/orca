import type {
  AgentJournalCursor,
  AgentSessionJournalIdentity
} from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { journalDispatchRowApplies } from '../projection/journal-dispatch-settlement'
import { journalQueueReopenRowBuilder } from '../context-epochs/journal-stop-and-resume-rows'
import type {
  JournalQueuedMessages,
  JournalQueuePlan
} from '../queued-messages/journal-queued-messages'
import { QueuedMessageNotOwedError } from '../queued-messages/queued-message-consume-error'
import type { JournalAttachmentClaim } from './journal-submission-hook'
import type Database from '../../../sqlite/sync-database'
import type { JournalReducerState } from '../projection/journal-reducer'
import {
  journalDispatchRowBuilder,
  journalSubmissionRowBuilder,
  journalItemRowBuilder
} from '../writing/journal-row-builders'
import type { JournalRow, JournalSubmissionRow } from '../durable-rows/journal-row-schema'
import type { JournalOperationReceipt, JournalRowWriter } from '../writing/journal-row-writer'
import type { JournalWriteAdmission } from '../writing/journal-write-queue'
import type {
  JournalSubmissionConsume,
  JournalSubmissionInput,
  JournalItemAppendInput,
  ResolveDispatchInput
} from '../journal-store-contracts'

export type JournalSubmissionWriterDeps = {
  state: () => JournalReducerState
  reopenFloor: () => AgentJournalCursor | null
  identity: AgentSessionJournalIdentity
  rowWriter: JournalRowWriter
  queuedMessages: JournalQueuedMessages
  claimAttachments: JournalAttachmentClaim
  validateDormantAnswer: (
    db: Database.Database,
    answer: { itemId: string; expectedRevision: number; contextEpoch: string }
  ) => void
}

export class JournalSubmissionWriter {
  constructor(private readonly deps: JournalSubmissionWriterDeps) {}

  /** Persist before dispatch; accepted echoes reuse the optimistic bubble. */
  append(
    input: JournalSubmissionInput,
    /** Validate the linked card on the write lane: one handoff, one delivery. */
    consume?: JournalSubmissionConsume,
    /** Commit the send's ledger answer with the row. */
    receipt?: JournalOperationReceipt,
    answer?: JournalItemAppendInput & {
      itemId: string
      expectedRevision: number
      contextEpoch: string
    },
    admission?: JournalWriteAdmission
  ): Promise<AgentJournalCursor> {
    const { claimAttachments, identity, queuedMessages, rowWriter, state } = this.deps
    const buildSubmission = journalSubmissionRowBuilder(state, identity, input, consume)
    let submitted: JournalSubmissionRow | undefined
    const submission = (seq: number, ts: number) => (submitted = buildSubmission(seq, ts))
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
          if (answer) {
            const prompt = state().items.get(answer.itemId)
            if (
              prompt?.revision !== answer.expectedRevision ||
              (prompt.body.kind !== 'approval' && prompt.body.kind !== 'question') ||
              prompt.body.resolution.state !== 'pending'
            ) {
              throw new Error('the saved question changed before its answer was saved')
            }
          }
          const rows = answer
            ? [
                submission,
                journalItemRowBuilder(state, answer.identity, answer.body, answer.options)
              ]
            : [submission]
          if (!consume) {
            return [...reopen, ...rows]
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
          return [...reopen, ...card.rows, ...rows]
        },
        {
          validate: (db) => {
            if (answer) {
              this.deps.validateDormantAnswer(db, answer)
            }
            receipt?.validate?.(db)
          },
          write: (db, row) => {
            card?.receipt.write(db)
            // New client sends require stored uploads; queued cards already claimed theirs.
            claimsCommitted = claimAttachments(
              db,
              input.body,
              input.origin === 'client' && !consume
            )
            receipt?.write(db, row, submitted)
          },
          committed: () => {
            claimsCommitted?.()
            card?.receipt.committed()
            receipt?.committed()
          }
        },
        (rows) => rows.at(-1),
        admission
      )
      .then(rowCursor)
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
    let witness: JournalQueuePlan | undefined
    await rowWriter.enqueueRows(
      () => {
        if (!journalDispatchRowApplies(state().submissions.get(input.clientMessageId))) {
          return []
        }
        witness = this.deps.queuedMessages.proofWitness(input.clientMessageId)
        return [...witness.rows, journalDispatchRowBuilder(state, input)]
      },
      {
        write: (db) => witness?.receipt.write(db),
        committed: () => witness?.receipt.committed()
      }
    )
  }
}

function rowCursor(rows: readonly JournalRow[]): AgentJournalCursor {
  const row = rows.at(-1)
  if (!row) {
    throw new Error('agent_session_journal_row_unwritten')
  }
  return { epoch: row.epoch, sequence: row.seq }
}
