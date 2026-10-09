import type { AgentSessionSendResult } from '../../../src/shared/agent-session-wire'
import {
  structuredAgentSessionSendBody,
  type StructuredAgentSessionAttachment
} from '../../../src/shared/structured-agent-session-send-mutation'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import {
  requestStructuredAgentSessionMutation,
  timeoutForDeadline
} from './mobile-structured-agent-session-rpc'
import { structuredSessionOperationId } from './structured-session-operation-id'
import { mobileStructuredSendDelivery } from './mobile-structured-send-delivery'
import type { MobileNativeChatSendErrorReporter } from './use-mobile-native-chat-send-error'

/** The current Send's id lets temporary text/photo rows settle against the host record. */
export type MobileStructuredSendResult = {
  outcome: MobileNativeChatSendOutcome
  clientMessageId: string | null
}

export const MOBILE_STRUCTURED_SEND_NOT_SENT: MobileStructuredSendResult = {
  outcome: 'rejected',
  clientMessageId: null
}

export async function sendMobileStructuredAgentSessionMessage(input: {
  client: RpcClient
  sessionId: string
  expectedRuntimeFence: number
  text: string
  attachments: readonly StructuredAgentSessionAttachment[]
  /** Sent only when the host advertises `agent-session.queued-messages.v1`. */
  delivery?: 'queue-if-active'
  deadline?: number
  onError: MobileNativeChatSendErrorReporter
}): Promise<MobileStructuredSendResult> {
  const timeoutMs = timeoutForDeadline(input.deadline)
  if (timeoutMs === null) {
    input.onError('Message not sent')
    return MOBILE_STRUCTURED_SEND_NOT_SENT
  }
  // Each Send owns one fresh id, also returned when its answer is unknown.
  const clientMessageId = structuredSessionOperationId()
  const result = await requestStructuredAgentSessionMutation<AgentSessionSendResult>({
    client: input.client,
    method: 'agentSession.send',
    fingerprintMethod: 'agentSession.send',
    sessionId: input.sessionId,
    expectedRuntimeFence: input.expectedRuntimeFence,
    fields: {
      body: structuredAgentSessionSendBody(input.text, input.attachments),
      ...(input.delivery ? { delivery: input.delivery } : {})
    },
    clientOperationId: clientMessageId,
    timeoutMs
  })
  const outcome = mobileStructuredSendDelivery(result)
  if (outcome.error !== null) {
    if (outcome.failure) {
      input.onError(outcome.error, { failure: outcome.failure })
    } else {
      input.onError(outcome.error)
    }
  }
  return { outcome: outcome.outcome, clientMessageId }
}
