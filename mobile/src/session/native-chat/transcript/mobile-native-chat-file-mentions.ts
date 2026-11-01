import {
  isTextBlock,
  type NativeChatBlock
} from '../../../../../src/shared/native-chat/native-chat-types'

// A line that is only a file mention, in formatNativeChatFileReference's forms: @path, @"path", @'path'.
const MENTION_LINE = /^@(?:"((?:\\"|[^"])+)"|'([^']+)'|([^\s"'@]+))$/
// Draw a tile only for something named like a file; @someone stays text.
const FILE_NAME = /[^/\\]\.[A-Za-z0-9]{1,8}$/

function mentionedFilePath(line: string): string | null {
  const match = MENTION_LINE.exec(line.trim())
  const path = match ? (match[1]?.replace(/\\"/g, '"') ?? match[2] ?? match[3] ?? '') : ''
  return FILE_NAME.test(path) ? path : null
}

// A shared document arrives as its own mention line; draw those as tiles beside the photos.
export function splitUserFileMentions(blocks: readonly NativeChatBlock[]): {
  paths: string[]
  blocks: NativeChatBlock[]
} {
  const paths: string[] = []
  const kept = blocks.flatMap((block): NativeChatBlock[] => {
    if (!isTextBlock(block)) {
      return [block]
    }
    const lines = block.text.split('\n')
    const rest = lines.filter((line) => {
      const path = mentionedFilePath(line)
      if (path) {
        paths.push(path)
      }
      return path === null
    })
    if (rest.length === lines.length) {
      return [block]
    }
    const text = rest.join('\n').trim()
    return text ? [{ ...block, text }] : []
  })
  return { paths, blocks: kept }
}
