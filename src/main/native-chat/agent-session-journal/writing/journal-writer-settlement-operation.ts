import type {
  JournalDeadGenerationSettlementInput,
  JournalStaleSettlementInput,
  JournalPromptMutationInput,
  JournalUnheldTurnsSettlementInput,
  JournalStartFailureSettlementInput
} from '../journal-store-contracts'
import type { JournalWriterSession } from '../journal-writer-session'
import type { JournalOperationReceipt } from './journal-row-writer'
import {
  settleJournalStaleState,
  settleJournalDeadGeneration,
  settleJournalUnheldTurns
} from './journal-generation-settlement'
import { journalGenerationSettlementRead } from './journal-generation-settlement-read'
import { journalGenerationSettlementItems } from './journal-generation-settlement-items'
import { JournalSqlScope } from '../journal-sql-scope'
import { mutateJournalPrompt } from './journal-prompt-mutation'
import { settleJournalStartFailure } from './journal-start-failure-settlement'

export type JournalWriterSettlementOperation =
  | { kind: 'stale-settle'; input: JournalStaleSettlementInput }
  | { kind: 'dead-generation-settle'; input: JournalDeadGenerationSettlementInput }
  | { kind: 'unheld-turns-settle'; input: JournalUnheldTurnsSettlementInput }
  | { kind: 'start-failure-settle'; input: JournalStartFailureSettlementInput }
  | { kind: 'prompt-mutate'; input: JournalPromptMutationInput }

export function runJournalWriterSettlementOperation(
  session: JournalWriterSession,
  operation: JournalWriterSettlementOperation,
  receipt: JournalOperationReceipt | undefined
): Promise<unknown> {
  const { collaborators } = session
  if (operation.kind === 'prompt-mutate') {
    return mutateJournalPrompt(
      { state: () => session.state, writer: collaborators.rowWriter },
      operation.input,
      receipt
    )
  }
  if (receipt) {
    throw new Error('journal generation settlements carry no receipt')
  }
  if (operation.kind === 'start-failure-settle') {
    return settleJournalStartFailure(
      () => session.state,
      collaborators.lifecycleBatchAppender,
      operation.input
    )
  }
  if (operation.kind === 'unheld-turns-settle') {
    return settleJournalUnheldTurns(
      () => session.state,
      collaborators.lifecycleBatchAppender,
      operation.input
    )
  }
  const journal = journalGenerationSettlementRead(
    () => session.state,
    collaborators,
    () =>
      journalGenerationSettlementItems(new JournalSqlScope(session.db, ...session.scopePrefix()))
  )
  return operation.kind === 'stale-settle'
    ? settleJournalStaleState(journal, collaborators.lifecycleBatchAppender, operation.input)
    : settleJournalDeadGeneration(journal, collaborators.lifecycleBatchAppender, operation.input)
}
