import { useEffect } from 'react'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import { clearMobileStructuredSettledSendOperations } from './mobile-structured-send-operation-journal'

export function useMobileStructuredSendOperationReconciliation(
  submissions: readonly AgentJournalSubmission[]
): void {
  useEffect(() => {
    void clearMobileStructuredSettledSendOperations({ submissions }).catch(() => undefined)
  }, [submissions])
}
