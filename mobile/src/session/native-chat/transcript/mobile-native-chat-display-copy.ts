import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import { agentMessageTranscriptText } from '../../../../../src/shared/agent-session/agent-message-display-text'
import { nativeChatMessageCopyText } from '../../../../../src/shared/native-chat-message-copy-text'

export function mobileNativeChatDisplayCopyText(message: NativeChatMessage): string {
  return message.role === 'user' && message.from
    ? agentMessageTranscriptText(message.blocks, message.from)
    : nativeChatMessageCopyText(message)
}
