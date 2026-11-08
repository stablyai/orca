import type {
  AgentJournalCursor,
  AgentJournalItemIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalStopAcceptance } from './context-epochs/journal-stop-acceptance'
import type { JournalStopEvent } from './durable-rows/journal-row-schema'
import type {
  JournalAppendResult,
  JournalItemAppendInput,
  JournalItemAppendOptions,
  JournalLifecycleBatchInput,
  JournalSubmissionConsume,
  JournalSubmissionInput,
  JournalTombstoneInput,
  ResolveDispatchInput
} from './journal-store-contracts'
import type { JournalSqlReads } from './journal-sql-reads'
import type {
  JournalSqlStoreAnswerFacts,
  JournalSqlStoreOperation,
  JournalSqlStorePrepare
} from './journal-sql-store'
import type { JournalWriterCommit } from './journal-writer-changes'
import { JournalHostFactsNeededError } from './journal-writer-host-facts'
import type { JournalOperationReceipt } from './writing/journal-row-writer'

/**
 * The in-memory journal's append surface, each method one writer command with the same answer.
 * The writer plans every row at its write position, so nothing here reads the chat first.
 */
export abstract class SqlJournalAppends {
  abstract readonly reads: JournalSqlReads

  abstract write(
    operation: JournalSqlStoreOperation,
    prepare?: JournalSqlStorePrepare,
    answerFacts?: JournalSqlStoreAnswerFacts
  ): Promise<JournalWriterCommit>

  appendItem(
    identity: AgentJournalItemIdentity,
    body: JournalItemAppendInput['body'],
    options: JournalItemAppendOptions,
    receipt?: JournalOperationReceipt
  ): Promise<JournalAppendResult> {
    return this.answerOf(this.write({ kind: 'item', identity, body, options }, receipted(receipt)))
  }

  appendClaimingAttachments(
    identity: AgentJournalItemIdentity,
    body: AgentJournalMessageItem,
    options: JournalItemAppendOptions
  ): Promise<JournalAppendResult> {
    return this.answerOf(this.write({ kind: 'item-claiming', identity, body, options }))
  }

  appendTombstone(
    identity: AgentJournalItemIdentity,
    { fence }: JournalTombstoneInput,
    receipt?: JournalOperationReceipt
  ): Promise<AgentJournalCursor> {
    return this.answerOf(this.write({ kind: 'tombstone', identity, fence }, receipted(receipt)))
  }

  withdrawGoalObjective(
    identity: AgentJournalItemIdentity,
    { fence }: JournalTombstoneInput
  ): Promise<AgentJournalCursor> {
    return this.answerOf(this.write({ kind: 'goal-withdraw', identity, fence }))
  }

  appendLifecycleBatch(input: JournalLifecycleBatchInput): Promise<AgentJournalCursor> {
    return this.answerOf(this.write({ kind: 'lifecycle', input }))
  }

  /** `consume.owed` is asked only when the writer reaches the handover it guards. */
  appendSubmission(
    input: JournalSubmissionInput,
    consume?: JournalSubmissionConsume,
    receipt?: JournalOperationReceipt
  ): Promise<AgentJournalCursor> {
    const owed = consume?.owed
    let selection: (Omit<JournalSubmissionConsume, 'owed'> & { owed?: true }) | undefined
    if (consume) {
      const { owed: _asked, ...rest } = consume
      selection = { ...rest, ...(owed ? { owed: true as const } : {}) }
    }
    return this.answerOf(
      this.write(
        { kind: 'submission', input, ...(selection ? { consume: selection } : {}) },
        receipted(receipt),
        owed &&
          ((_context, needs) => {
            if (!needs.owed || needs.stoppedCut || needs.rewound) {
              throw new JournalHostFactsNeededError(needs)
            }
            return { facts: { owed: owed() }, ...(receipt ? { receipt } : {}) }
          })
      )
    )
  }

  resolveDispatch(
    input: ResolveDispatchInput,
    receipt?: JournalOperationReceipt
  ): Promise<AgentJournalCursor | null> {
    return this.answerOf(this.write({ kind: 'dispatch', input }, receipted(receipt)))
  }

  appendStopEvent(event: Omit<JournalStopEvent, 'at'>, fence: number): Promise<AgentJournalCursor> {
    return this.answerOf(this.write({ kind: 'stop', event, fence }))
  }

  /** Withdraw held sends and write the Stop atomically; the live turn is the host's answer now. */
  acceptStop(
    input: { event: Omit<JournalStopEvent, 'at'>; fence: number; liveTurnId: string | null },
    receipt?: JournalOperationReceipt
  ): Promise<JournalStopAcceptance> {
    return this.answerOf(this.write({ kind: 'stop-accept', ...input }, receipted(receipt)))
  }

  turnWasRemoved(turnId: string): Promise<boolean> {
    return this.reads.turnWasRemoved(turnId)
  }

  appendQueueResume(fence: number, receipt?: JournalOperationReceipt): Promise<AgentJournalCursor> {
    return this.answerOf(this.write({ kind: 'queue-resume', fence }, receipted(receipt)))
  }

  appendQueueReopen(fence: number, since?: number): Promise<AgentJournalCursor> {
    return this.answerOf(this.write({ kind: 'queue-reopen', fence, since }))
  }

  /** The writer answers each command with the value its in-memory procedure returns. */
  protected async answerOf<T>(commit: Promise<JournalWriterCommit>): Promise<T> {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the writer runs the named command's own procedure and returns its value unchanged.
    return (await commit).value as T
  }
}

function receipted(
  receipt: JournalOperationReceipt | undefined
): JournalSqlStorePrepare | undefined {
  return receipt && (() => ({ receipt }))
}
