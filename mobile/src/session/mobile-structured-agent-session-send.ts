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
import { mobileStructuredSendDelivery } from './mobile-structured-send-delivery'
import type { MobileNativeChatSendErrorReporter } from './use-mobile-native-chat-send-error'

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
}): Promise<MobileNativeChatSendOutcome> {
  const timeoutMs = timeoutForDeadline(input.deadline)
  if (timeoutMs === null) {
    input.onError('Message not sent')
    return 'rejected'
  }
  // Each Send is a new action; the shared mutation sender mints its operation id once.
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
  return outcome.outcome
}
