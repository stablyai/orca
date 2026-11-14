import type {
  AgentJournalCursor,
  AgentJournalItemIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  JournalStopAcceptance,
  JournalAppendResult,
  JournalLateDispatchInput,
  JournalShutdownCutInput,
  JournalCommandSettlementInput,
  JournalCommandOpenInput,
  JournalHandoverInput,
  JournalItemAppendInput,
  JournalItemAppendOptions,
  JournalLifecycleBatchInput,
  JournalStaleSettlementInput,
  JournalDeadGenerationSettlementInput,
  JournalPromptMutationInput,
  JournalUnheldTurnsSettlementInput,
  JournalStartFailureSettlementInput,
  JournalSubmissionConsume,
  JournalSubmissionInput,
  JournalTombstoneInput,
  ResolveDispatchInput,
  JournalCommandOpenResult
} from './journal-store-contracts'
import type { JournalStopEvent } from './durable-rows/journal-row-schema'
import type { JournalSqlReads } from './journal-sql-reads'
import type { JournalSqlStoreOperation, JournalSqlStorePrepare } from './journal-sql-store'
import type { JournalWriterCommit } from './journal-writer-changes'
import type { JournalOperationReceipt } from './writing/journal-row-writer'
import type { JournalWriterStep, JournalStepsResult } from './writing/journal-writer-step'
import type { StoppedHistoryDelivery } from '../../../shared/agent-session/lifecycle/stopping/agent-session-stopped-history'
import type { JournalWriterSettled } from './journal-sql-failure'
import { restoreJournalSqlFailure } from './journal-sql-failure'
import { claimJournalAutomaticSubmission } from './journal-sql-automatic-submission'
import type { JournalAutomaticSelection } from './journal-automatic-submission'
import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import type { QueuedMessageOwed } from './queued-messages/queued-message-consume-error'
import type { AgentSessionRewindRecord } from '../../../shared/agent-session/lifecycle/rewind/agent-session-rewind'
import type { JournalRewindCut } from './journal-domain-rewind-cut'

/**
 * The in-memory journal's append surface, each method one writer command with the same answer.
 * The writer plans every row at its write position, so nothing here reads the chat first.
 */
export abstract class SqlJournalAppends {
  abstract readonly reads: JournalSqlReads
  abstract reopenFloor(): AgentJournalCursor | null

  abstract write(
    operation: JournalSqlStoreOperation,
    prepare?: JournalSqlStorePrepare
  ): Promise<JournalWriterCommit>

  completeRewind(
    rewind: AgentSessionRewindRecord,
    fence: number,
    expectedCut: JournalRewindCut | null,
    receipt: JournalOperationReceipt
  ): Promise<AgentJournalCursor> {
    return this.answerOf(
      this.write({ kind: 'rewind-cut', rewind, fence, expectedCut }, receipted(receipt))
    )
  }

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

  settleTakenStop(turnId: string, fence: number, completedAt: number): Promise<boolean> {
    return this.answerOf(
      this.write({
        kind: 'lifecycle',
        input: { settlementId: `stop-settled:${turnId}`, fence, mutations: [] },
        takenStop: { turnId, completedAt }
      })
    )
  }

  appendSteps(
    steps: readonly JournalWriterStep[],
    beforeRun?: () => boolean
  ): Promise<JournalStepsResult> {
    const operation: Extract<JournalSqlStoreOperation, { kind: 'steps' }> = { kind: 'steps', steps }
    return this.answerOf(
      this.write(operation, () => {
        operation.dropped = beforeRun?.() === false
        return {}
      })
    )
  }

  settleStaleState(input: JournalStaleSettlementInput): Promise<number> {
    return this.answerOf(this.write({ kind: 'stale-settle', input }))
  }

  settleDeadGeneration(input: JournalDeadGenerationSettlementInput): Promise<number> {
    return this.answerOf(this.write({ kind: 'dead-generation-settle', input }))
  }

  settleUnheldTurns(input: JournalUnheldTurnsSettlementInput): Promise<void> {
    return this.answerOf(this.write({ kind: 'unheld-turns-settle', input }))
  }

  settleStartFailure(input: JournalStartFailureSettlementInput): Promise<void> {
    return this.answerOf(this.write({ kind: 'start-failure-settle', input }))
  }

  mutatePrompt(
    input: JournalPromptMutationInput,
    receipt?: JournalOperationReceipt
  ): Promise<JournalAppendResult> {
    return this.answerOf(this.write({ kind: 'prompt-mutate', input }, receipted(receipt)))
  }

  /** Capture the external handover decision on this chat's lane before writer admission. */
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
        () => ({
          ...(owed ? { facts: { owed: owed() } } : {}),
          ...(receipt ? { receipt } : {})
        })
      )
    )
  }

  claimAutomaticSubmission(
    input: { clientMessageId: string; fence: number },
    capture: () => JournalAutomaticSelection | Promise<JournalAutomaticSelection>,
    owed: (source: AgentMessageSource) => QueuedMessageOwed,
    receipt?: JournalOperationReceipt
  ) {
    return claimJournalAutomaticSubmission(this, input, capture, owed, receipt)
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

  /** Queue ownership is selected in the writer, after every earlier admitted command. */
  async settleLateDispatch(input: JournalLateDispatchInput): Promise<void> {
    await this.write({ kind: 'late-dispatch', input })
  }

  async appendShutdownCut(input: JournalShutdownCutInput): Promise<void> {
    await this.write({ kind: 'shutdown-cut', input })
  }

  async prepareHandover(input: JournalHandoverInput): Promise<StoppedHistoryDelivery | null> {
    const { value } = await this.write({ kind: 'handover', input })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handover returns only its stopped-history delivery result.
    return value as StoppedHistoryDelivery | null
  }

  async openCommand(input: JournalCommandOpenInput): Promise<JournalCommandOpenResult> {
    const { value } = await this.write({ kind: 'command-open', input })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: command-open returns its typed settled result from the writer dispatcher.
    const result = value as JournalWriterSettled<JournalCommandOpenResult>
    if ('failure' in result) {
      throw restoreJournalSqlFailure(result.failure)
    }
    return result.value
  }

  async settleCommand(input: JournalCommandSettlementInput): Promise<void> {
    const { value } = await this.write({ kind: 'command-settle', input })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: command-settle returns its typed settled result from the writer dispatcher.
    const result = value as JournalWriterSettled
    if ('failure' in result) {
      throw restoreJournalSqlFailure(result.failure)
    }
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
