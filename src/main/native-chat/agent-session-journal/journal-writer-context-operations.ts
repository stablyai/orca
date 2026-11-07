import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionProviderContextBoundary } from '../../../shared/agent-session/agent-session-provider-context'
import type { AgentJournalEpochReason, JournalEpochRow } from './durable-rows/journal-row-schema'
import type { JournalReplacementItem } from './context-epochs/journal-epoch-replacement'
import { journalRewoundReceipt } from './journal-writer-rewind-receipt'
import type { JournalWriterSession } from './journal-writer-session'
import type { JournalOperationReceipt } from './writing/journal-row-writer'

/** Context and epoch commands; a rewind's completion is staged from what the writer proves it left. */
export type JournalWriterContextOperation =
  | { kind: 'context-clear'; boundary: AgentSessionProviderContextBoundary }
  | {
      kind: 'context-rewind'
      floor: AgentJournalCursor
      fence: number
      items: readonly JournalReplacementItem[]
    }
  | {
      kind: 'epoch-replace'
      reason: AgentJournalEpochReason
      fence: number
      items: readonly JournalReplacementItem[]
      providerHandle?: JournalEpochRow['providerHandle']
    }

export function runJournalWriterContextOperation(
  session: JournalWriterSession,
  operation: JournalWriterContextOperation,
  receipt: JournalOperationReceipt | undefined
): Promise<AgentJournalCursor> {
  const { collaborators } = session
  switch (operation.kind) {
    case 'context-clear':
      if (!receipt) {
        throw new Error('a context clear carries its conversation receipt')
      }
      return collaborators.context.clear(operation.boundary, receipt)
    case 'context-rewind':
      // Rewind always settles a completion; without one the writer still proves its cursor.
      return collaborators.context.rewind(
        operation.floor,
        operation.fence,
        operation.items,
        journalRewoundReceipt(session.rewound, receipt ?? { write: () => {}, committed: () => {} })
      )
    case 'epoch-replace':
      return collaborators.epochController.replace(
        operation.reason,
        operation.fence,
        operation.items,
        receipt && journalRewoundReceipt(session.rewound, receipt),
        ...(operation.providerHandle === undefined ? [] : [operation.providerHandle])
      )
  }
}
