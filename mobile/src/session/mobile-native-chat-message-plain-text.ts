import {
  AGENT_SESSION_HOST_STATUS_COPY,
  isAgentSessionHostStatusPresentation
} from '../../../src/shared/agent-session-host-status-rows'
import { isTextBlock } from '../../../src/shared/native-chat-types'
import { withoutNativeChatVisualDirectiveLines } from '../../../src/shared/native-chat-visual-directive'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

/** Copy the displayed prose, excluding tool activity and image attachments. */
export function nativeChatMessagePlainText(
  message: Pick<NativeChatMessage, 'role' | 'blocks'>
): string {
  // Preserve indentation in code and nested lists.
  return message.blocks
    .filter(isTextBlock)
    .map((block) => {
      if (isAgentSessionHostStatusPresentation(block.presentation)) {
        return AGENT_SESSION_HOST_STATUS_COPY[block.presentation]
      }
      // Own messages display directive syntax literally.
      return message.role === 'user'
        ? block.text
        : withoutNativeChatVisualDirectiveLines(block.text)
    })
    .filter((text) => text.trim().length > 0)
    .join('\n\n')
}
