import { useEffect } from 'react'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import type { MobileQueuedMessageFeed } from './mobile-structured-queued-message-feed'
import {
  clearMobileStructuredQueuedSendOperations,
  clearMobileStructuredSettledSendOperations
} from './mobile-structured-send-operation-journal'

export function useMobileStructuredSendOperationReconciliation(
  submissions: readonly AgentJournalSubmission[],
  queuedMessages: MobileQueuedMessageFeed = null
): void {
  useEffect(() => {
    void clearMobileStructuredSettledSendOperations({ submissions }).catch(() => undefined)
  }, [submissions])
  useEffect(() => {
    if (!queuedMessages || queuedMessages.length === 0) {
      return
    }
    void clearMobileStructuredQueuedSendOperations({
      queuedMessageIds: queuedMessages.map((draft) => draft.messageId)
    }).catch(() => undefined)
  }, [queuedMessages])
}
