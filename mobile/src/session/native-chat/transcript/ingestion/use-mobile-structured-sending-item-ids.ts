import { useMemo, useSyncExternalStore } from 'react'
import { structuredAgentSessionSendingItemIds } from '../../../../../../src/shared/agent-session/view/structured-agent-session-sending'
import type {
  StructuredAgentSubmission,
  SubmissionReceipts
} from '../../../../../../src/shared/agent-session/view/structured-agent-session-submissions'
import type { StructuredAgentSessionOptimisticMessage } from '../../../../../../src/shared/agent-session/view/structured-agent-session-message-projection'

export type MobileStructuredReceiptSource = {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => SubmissionReceipts
}

export type MobileStructuredSending = {
  receipts: MobileStructuredReceiptSource
  submissions: readonly StructuredAgentSubmission[]
  pending: readonly StructuredAgentSessionOptimisticMessage[]
}

const noSubscription = () => () => {}
const noSnapshot = () => undefined

export function useMobileStructuredSendingItemIds(sending: MobileStructuredSending | undefined) {
  const receipts = useSyncExternalStore(
    sending?.receipts.subscribe ?? noSubscription,
    sending?.receipts.getSnapshot ?? noSnapshot
  )
  return useMemo(
    () =>
      sending && receipts
        ? structuredAgentSessionSendingItemIds(sending.pending, sending.submissions, receipts)
        : undefined,
    [sending, receipts]
  )
}
