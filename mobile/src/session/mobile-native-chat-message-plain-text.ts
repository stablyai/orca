import { isTextBlock } from '../../../src/shared/native-chat-types'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

/** The message's prose as one string, for the clipboard and the selection screen. Tool calls and
 *  images carry nothing a person would paste, so they are skipped. */
export function nativeChatMessagePlainText(message: Pick<NativeChatMessage, 'blocks'>): string {
  // Whitespace stays: indentation inside a block is content (code, nested lists); only blocks
  // that are nothing but whitespace are dropped.
  return message.blocks
    .filter(isTextBlock)
    .map((block) => block.text)
    .filter((text) => text.trim().length > 0)
    .join('\n\n')
}
