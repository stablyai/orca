import { useEffect } from 'react'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import { reconcileMobileStructuredSendOperations } from './mobile-structured-send-operation-journal'

export function useMobileStructuredSendOperationReconciliation(
  submissions: readonly AgentJournalSubmission[]
): void {
  useEffect(() => {
    void reconcileMobileStructuredSendOperations({ submissions }).catch(() => undefined)
  }, [submissions])
}
