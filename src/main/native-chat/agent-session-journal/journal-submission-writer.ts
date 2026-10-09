// A sent message's rows: its write-ahead submission and each dispatch transition, with what must
// commit in the same transaction (a queued draft's consume, the send's ledger answer, a kept card).

import type {
  AgentJournalCursor,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalQueuedMessages } from './journal-queued-messages'
import { journalSubmissionHook, type JournalAttachmentClaim } from './journal-submission-hook'
import type { JournalReducerState } from './journal-reducer'
import { journalDispatchRowBuilder, journalSubmissionRowBuilder } from './journal-row-builders'
import type {
  JournalOperationReceipt,
  JournalRowTransactionHook,
  JournalRowWriter
} from './journal-row-writer'
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
    /** Present: this submission is a queued draft's conversion, and the draft's
     *  state transition commits in the SAME transaction — exactly-once consume. */
    consume?: JournalSubmissionConsume,
    /** The send's ledger answer, committed with this row. */
    receipt?: JournalOperationReceipt
  ): Promise<AgentJournalCursor> {
    const { claimAttachments, identity, queuedMessages, rowWriter, state } = this.deps
    return rowWriter.append(
      journalSubmissionRowBuilder(state, identity, input, consume),
      journalSubmissionHook(queuedMessages, claimAttachments, input, consume),
      receipt
    )
  }

  /**
   * Record a dispatch transition: the handover of a send not yet handed over, or a settlement.
   *
   * Accepting REQUIRES the provider identity rather than a free-form id: the
   * adopted key is what the provider's echo will upsert into, so a mismatched
   * string here would silently give the user a second copy of their own message.
   * `hook` runs in the row's transaction: it commits with the row, or rolls it back by throwing.
   */
  resolveDispatch(
    input: ResolveDispatchInput,
    hook?: JournalRowTransactionHook
  ): Promise<AgentJournalCursor> {
    return this.deps.rowWriter.append(journalDispatchRowBuilder(this.deps.state, input), hook)
  }
}
