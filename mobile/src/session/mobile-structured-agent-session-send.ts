import type { AgentSessionSendResult } from '../../../src/shared/agent-session-wire'
import {
  structuredAgentSessionSendBody,
  type StructuredAgentSessionAttachment
} from '../../../src/shared/structured-agent-session-outbox'
import {
  structuredAgentSessionDomainFingerprint,
  structuredAgentSessionPayloadFingerprint
} from '../../../src/shared/structured-agent-session-mutation'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import {
  requestStructuredAgentSessionMutation,
  structuredSessionOperationId,
  timeoutForDeadline
} from './mobile-structured-agent-session-rpc'
import { mobileStructuredSendDelivery } from './mobile-structured-send-delivery'
import {
  clearMobileStructuredSendOperation,
  getOrCreateMobileStructuredSendOperation,
  mobileStructuredSendOperationKey
} from './mobile-structured-send-operation-journal'

export async function sendMobileStructuredAgentSessionMessage(input: {
  client: RpcClient
  sessionId: string
  sessionKey: string
  callerIdentity: string
  expectedRuntimeFence: number
  text: string
  attachments: readonly (StructuredAgentSessionAttachment & { contentFingerprint?: string })[]
  deadline?: number
  onError: (message: string) => void
}): Promise<MobileNativeChatSendOutcome> {
  const timeoutMs = timeoutForDeadline(input.deadline)
  if (timeoutMs === null) {
    input.onError('Message not sent')
    return 'rejected'
  }
  const requestedBody = structuredAgentSessionSendBody(input.text, input.attachments)
  const requestedPayloadFingerprint = structuredAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId: input.sessionId,
    fields: { body: requestedBody }
  })
  const intentFingerprint = structuredAgentSessionDomainFingerprint({
    domain: 'mobile.agentSession.send.intent',
    sessionId: input.sessionKey,
    fields: {
      text: input.text.trimEnd(),
      attachments: input.attachments.map(
        (attachment) =>
          attachment.contentFingerprint ??
          structuredAgentSessionDomainFingerprint({
            domain: 'mobile.nativeChat.image.preview',
            sessionId: '',
            fields: { previewUri: attachment.previewUri }
          })
      )
    }
  })
  const operationKey = mobileStructuredSendOperationKey({
    sessionKey: input.sessionKey,
    intentFingerprint
  })
  let operation: Awaited<ReturnType<typeof getOrCreateMobileStructuredSendOperation>>
  try {
    operation = await getOrCreateMobileStructuredSendOperation({
      operationKey,
      callerIdentity: input.callerIdentity,
      payloadFingerprint: requestedPayloadFingerprint,
      attachmentPaths: input.attachments.map((attachment) => attachment.path),
      createOperationId: structuredSessionOperationId
    })
  } catch {
    input.onError('Message not sent')
    return 'rejected'
  }
  const body = structuredAgentSessionSendBody(
    input.text,
    operation.attachmentPaths.map((path) => ({ path, previewUri: '' }))
  )
  const payloadFingerprint = structuredAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId: input.sessionId,
    fields: { body }
  })
  if (payloadFingerprint !== operation.payloadFingerprint) {
    input.onError('Message not sent')
    return 'rejected'
  }
  const result = await requestStructuredAgentSessionMutation<AgentSessionSendResult>({
    client: input.client,
    method: 'agentSession.send',
    fingerprintMethod: 'agentSession.send',
    sessionId: input.sessionId,
    expectedRuntimeFence: input.expectedRuntimeFence,
    fields: { body },
    clientOperationId: operation.operationId,
    timeoutMs
  })
  const delivery = mobileStructuredSendDelivery(result, operation.retained)
  if (delivery.operationIdSpent) {
    try {
      await clearMobileStructuredSendOperation({
        operationKey,
        operationId: operation.operationId
      })
    } catch {
      // A retained settled id can suppress a later identical send, never
      // duplicate this one; the next replay gets another clear chance.
    }
  }
  if (delivery.error !== null) {
    input.onError(delivery.error)
  }
  return delivery.outcome
}
