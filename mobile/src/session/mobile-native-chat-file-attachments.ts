import { mobileMarkdownLiteralRanges } from '../components/mobile-markdown-tree'
import { formatNativeChatFileReference } from '../../../src/shared/agent-image-paste'
import { isAgentSessionAttachmentStorePath } from '../../../src/shared/agent-session-attachments'
import { isTextBlock, type NativeChatBlock } from '../../../src/shared/native-chat-types'

/** Desktop file attachments are serialized as @ references, without a separate wire block. */
export function splitMobileNativeChatFileAttachments(blocks: readonly NativeChatBlock[]): {
  files: string[]
  prose: NativeChatBlock[]
} {
  const files = new Set<string>()
  const prose = blocks.flatMap((block) => {
    if (!isTextBlock(block) || block.presentation || !block.text.includes('@')) {
      return [block]
    }
    const literalRanges = mobileMarkdownLiteralRanges(block.text)
    let rangeIndex = 0
    const text = block.text.replace(
      /(^|\s)(@"(?:\\"|[^"\r\n])*"|@'[^'\r\n]*'|@[^\s]+)(?=\s|$)/g,
      (match: string, space: string, token: string, offset: number) => {
        const position = offset + space.length
        while (literalRanges[rangeIndex] && literalRanges[rangeIndex]!.end <= position) {
          rangeIndex += 1
        }
        const range = literalRanges[rangeIndex]
        if (range && range.start <= position && position < range.end) {
          return match
        }
        const quoted = token[1] === '"' || token[1] === "'"
        const path = quoted ? token.slice(2, -1).replace(/\\"/g, '"') : token.slice(1)
        if (
          !isAgentSessionAttachmentStorePath(path) ||
          formatNativeChatFileReference(path) !== token
        ) {
          return match
        }
        files.add(path)
        return space === '\n' || space === '\r' ? space : ''
      }
    )
    return text === block.text ? [block] : text.trim().length > 0 ? [{ ...block, text }] : []
  })
  return { files: [...files], prose }
}
