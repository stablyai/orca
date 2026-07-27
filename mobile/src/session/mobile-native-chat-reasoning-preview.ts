import type { NativeChatBlock } from '../../../src/shared/native-chat-types'
import { isTextBlock } from '../../../src/shared/native-chat-types'

const PREVIEW_CHARS = 80

/** The collapsed reasoning disclosure's one-line label: the first line that has
 *  content, clipped. Scans by index so a long thought never allocates a line
 *  array just to show 80 characters. */
export function reasoningPreviewLine(blocks: NativeChatBlock[]): string {
  for (const block of blocks) {
    if (!isTextBlock(block)) {
      continue
    }
    const { text } = block
    let start = 0
    while (start < text.length) {
      const newline = text.indexOf('\n', start)
      const end = newline === -1 ? text.length : newline
      const line = text.slice(start, end)
      if (line.trim()) {
        return line.slice(0, PREVIEW_CHARS)
      }
      start = end + 1
    }
  }
  return ''
}
