import type { AgentSessionSendResult } from '../../../src/shared/agent-session-wire'
import type {
  AgentJournalCursor,
  AgentJournalSkillRef
} from '../../../src/shared/agent-session-journal-types'
import {
  structuredAgentSessionSendBody,
  type StructuredAgentSessionAttachment
} from '../../../src/shared/structured-agent-session-send-mutation'
import { structuredAgentSessionBlocksTooLarge } from '../../../src/shared/rpc-contract/structured-agent-session-message-params'
import {
  AGENT_SESSION_MESSAGE_TOO_LARGE_PARTS,
  agentSessionWriteNoticeEnglish
} from '../../../src/shared/agent-session-refusal-notice'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileNativeChatSendOutcome } from './native-chat/mobile-native-chat-send'
import {
  requestStructuredAgentSessionMutation,
  timeoutForDeadline
} from './mobile-structured-agent-session-rpc'
import { mobileStructuredSendDelivery } from './mobile-structured-send-delivery'
import type { MobileNativeChatSendErrorReporter } from './native-chat/use-mobile-native-chat-send-error'

export async function sendMobileStructuredAgentSessionMessage(input: {
  client: RpcClient
  sessionId: string
  expectedRuntimeFence: number
  text: string
  attachments: readonly StructuredAgentSessionAttachment[]
  /** Sent only when the host advertises `agent-session.send-skills.v1`. */
  skills?: readonly AgentJournalSkillRef[]
  /** Sent only when the host advertises `agent-session.queued-messages.v1`. */
  delivery?: 'queue-if-active'
  /** Sent only when the host advertises `agent-session.send-options.v1`. */
  options?: Readonly<Record<string, string>>
  deadline?: number
  clientMessageId: string
  onError: MobileNativeChatSendErrorReporter
  onAccepted?: (cursor: AgentJournalCursor | undefined) => void
}): Promise<MobileNativeChatSendOutcome> {
  const timeoutMs = timeoutForDeadline(input.deadline)
  if (timeoutMs === null) {
    input.onError('Message not sent')
    return 'rejected'
  }
  const body = structuredAgentSessionSendBody(input.text, input.attachments, input.skills)
  // The host refuses it unexplained, so say why here and keep the draft.
  if (structuredAgentSessionBlocksTooLarge(body.blocks)) {
    input.onError(agentSessionWriteNoticeEnglish(AGENT_SESSION_MESSAGE_TOO_LARGE_PARTS))
    return 'rejected'
  }
  // Use one operation id per Send action so separate taps cannot replay each other.
  const result = await requestStructuredAgentSessionMutation<AgentSessionSendResult>({
    client: input.client,
    method: 'agentSession.send',
    fingerprintMethod: 'agentSession.send',
    sessionId: input.sessionId,
    expectedRuntimeFence: input.expectedRuntimeFence,
    fields: {
      body,
      ...(input.delivery ? { delivery: input.delivery } : {}),
      ...(input.options ? { options: input.options } : {})
    },
    clientOperationId: input.clientMessageId,
    timeoutMs
  })
  const outcome = mobileStructuredSendDelivery(result)
  if (outcome.error !== null) {
    input.onError(outcome.error)
  }
  if (outcome.outcome === 'accepted' && result.status === 'accepted') {
    input.onAccepted?.(result.cursor)
  }
  return outcome.outcome
}
