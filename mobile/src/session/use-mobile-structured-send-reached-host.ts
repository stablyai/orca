import { useMemo } from 'react'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import type { MobileStructuredSendReachedHost } from './mobile-native-chat-draft-reconcile'
import { mobileStructuredSendReceipts } from './mobile-structured-send-receipts'

/** Whether the loaded journal holds the structured send made under an id, in any state; the same
 *  record the phone's id reconciliation reads. Rebuilt only when the submissions change. */
export function useMobileStructuredSendReachedHost(
  submissions: readonly AgentJournalSubmission[]
): MobileStructuredSendReachedHost {
  return useMemo(() => {
    const sends = mobileStructuredSendReceipts(submissions)
    return (clientMessageId) => sends.has(clientMessageId)
  }, [submissions])
}
