import { randomUUID } from 'node:crypto'
import { NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE } from '../../../../shared/native-chat/transcript/continuation/native-chat-usage-limit-cut'
import { structuredAgentSessionMessageSendMutation } from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { connectorClaimFor } from './structured-agent-session-connector-claims'
import {
  usageLimitContinueMessageId,
  usageLimitContinueTag,
  type HostUsageLimitCut
} from './structured-agent-session-usage-limit-chain'

/** An automatic continue of a usage-limit cut; it claims the connector requests the cut owes. */
export async function usageLimitContinueMutation(input: {
  sessionId: string
  cut: Pick<HostUsageLimitCut, 'turnItemId' | 'resetsAt'>
  at: number
  expectedRuntimeFence: number
}) {
  const { sessionId, cut } = input
  const claim = await connectorClaimFor(sessionId, { turnId: cut.turnItemId, kind: 'usage_limit' })
  return structuredAgentSessionMessageSendMutation({
    sessionId,
    clientOperationId: usageLimitContinueMessageId(
      input.at,
      usageLimitContinueTag(cut),
      randomUUID().replaceAll('-', '').slice(0, 16)
    ),
    expectedRuntimeFence: input.expectedRuntimeFence,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE }],
      ...(claim ? { connectorClaim: claim } : {})
    },
    usageLimitContinuationOfTurnItemId: cut.turnItemId
  })
}
