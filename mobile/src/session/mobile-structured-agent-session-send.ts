import type { AgentJournalMessageItem } from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionSendResult } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import {
  requestStructuredAgentSessionMutation,
  timeoutForDeadline
} from './mobile-structured-agent-session-rpc'
import { structuredSessionOperationId } from './structured-session-operation-id'
import { mobileStructuredSendDelivery } from './mobile-structured-send-delivery'

export async function sendMobileStructuredAgentSessionMessage(input: {
  client: RpcClient
  sessionId: string
  expectedRuntimeFence: number
  body: AgentJournalMessageItem
  deadline?: number
  onError: (message: string) => void
}): Promise<MobileNativeChatSendOutcome> {
  const timeoutMs = timeoutForDeadline(input.deadline)
  if (timeoutMs === null) {
    input.onError('Message not sent')
    return 'rejected'
  }
  const result = await requestStructuredAgentSessionMutation<AgentSessionSendResult>({
    client: input.client,
    method: 'agentSession.send',
    fingerprintMethod: 'agentSession.send',
    sessionId: input.sessionId,
    expectedRuntimeFence: input.expectedRuntimeFence,
    fields: { body: input.body },
    // One id per press, which the host also keeps as the message's client id.
    clientOperationId: structuredSessionOperationId(),
    timeoutMs
  })
  const delivery = mobileStructuredSendDelivery(result)
  if (delivery.error !== null) {
    input.onError(delivery.error)
  }
  return delivery.outcome
}
