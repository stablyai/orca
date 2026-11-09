import { createHash, randomUUID } from 'node:crypto'
import { NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE } from '../../../../shared/native-chat/native-chat-usage-limit-cut'
import { structuredAgentSessionMessageSendMutation } from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'

/** The automatic "Continue where you left off." send for one usage-limit cut. */
export function usageLimitContinueMutation(
  sessionId: string,
  cut: { turnItemId: string },
  cutIdentity: string,
  expectedRuntimeFence: number,
  at: number
) {
  const tag = createHash('sha256').update(cutIdentity).digest('hex').slice(0, 16)
  return structuredAgentSessionMessageSendMutation({
    sessionId,
    clientOperationId: `${Math.trunc(at).toString().padStart(13, '0')}-${tag}${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    expectedRuntimeFence,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE }]
    },
    usageLimitContinuationOfTurnItemId: cut.turnItemId
  })
}
