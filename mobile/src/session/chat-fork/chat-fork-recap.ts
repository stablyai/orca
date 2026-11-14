import { buildAgentSessionContinuationPrompt } from '../../../../src/shared/agent-session/context/agent-session-continuation'
import { buildAgentSessionHandoffContext } from '../../../../src/shared/agent-session-handoff-context'
import type { TuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'

/** Another agent's first message: a recap of this chat through the fork point, built here with no model call.
 *  Null when nothing before the fork point has words to hand over. */
export function buildChatForkRecap(input: {
  messages: readonly NativeChatMessage[]
  throughMessageId: string
  sourceAgent: TuiAgent
  sourceTitle?: string
}): string | null {
  const end = input.messages.findIndex((message) => message.id === input.throughMessageId)
  if (end === -1) {
    return null
  }
  return buildAgentSessionContinuationPrompt(
    {
      sourceKind: 'chat',
      sourceAgent: input.sourceAgent,
      sourceTitle: input.sourceTitle,
      capturedText: buildAgentSessionHandoffContext(input.messages.slice(0, end + 1))
    },
    'focused'
  )
}
