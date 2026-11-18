import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatMessage } from '../../../shared/native-chat/native-chat-types'

/**
 * A tool output or patch too large to load arrives as an excerpt (its start and end); the
 * transcript wraps that excerpt in private markers so the snapshot writer can stream the whole
 * text in its place, while the short hand-off summary keeps only the excerpt.
 */
export class ContinuedTranscriptMarkers {
  private readonly id = randomUUID()
  private readonly pattern = new RegExp(
    `\u0000orca-continued:${this.id}:(\\d+)\u0001([\\s\\S]*?)\u0000orca-continued-end:${this.id}\u0001`,
    'g'
  )

  mark(item: AgentJournalRenderItem, index: number): AgentJournalRenderItem {
    const { body } = item
    const wrap = (head: string) =>
      `\u0000orca-continued:${this.id}:${index}\u0001${head}\u0000orca-continued-end:${this.id}\u0001`
    if (body.kind === 'diff') {
      return { ...item, body: { ...body, patch: { ...body.patch, head: wrap(body.patch.head) } } }
    }
    if (body.kind === 'tool-call' && body.output) {
      return {
        ...item,
        body: { ...body, output: { ...body.output, head: wrap(body.output.head) } }
      }
    }
    return item
  }

  /** The messages with each marked text back to its excerpt. */
  excerpts(messages: readonly NativeChatMessage[]): NativeChatMessage[] {
    return messages.map((message) => ({
      ...message,
      blocks: message.blocks.map((block) =>
        block.type === 'tool-result'
          ? { ...block, output: block.output.replace(this.pattern, '$2') }
          : block
      )
    }))
  }

  /**
   * Formatted messages joined as the plain transcript is, each marked excerpt replaced by its
   * whole text. A message's formatting trims trailing whitespace, so a whole text that ends its
   * message is trimmed too.
   */
  async *transcript(
    messages: readonly string[],
    whole: (index: number) => AsyncIterable<string>
  ): AsyncGenerator<string> {
    for (const [position, message] of messages.entries()) {
      if (position > 0) {
        yield '\n\n'
      }
      let end = 0
      for (const match of message.matchAll(this.pattern)) {
        yield message.slice(end, match.index)
        end = match.index + match[0].length
        const text = whole(Number(match[1]))
        yield* end === message.length ? withoutTrailingWhitespace(text) : text
      }
      yield message.slice(end)
    }
  }
}

async function* withoutTrailingWhitespace(text: AsyncIterable<string>): AsyncGenerator<string> {
  let pending = ''
  for await (const chunk of text) {
    const joined = pending + chunk
    const kept = joined.trimEnd()
    if (kept) {
      yield kept
    }
    pending = joined.slice(kept.length)
  }
}

/**
 * Decodes stored bytes the way the whole text once decoded: SQLite hands a lone surrogate back
 * as three bytes (ED A0-BF 80-BF) where JavaScript wrote one U+FFFD, so those become EF BF BD.
 */
export async function* decodeStoredText(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8')
  let carry: Buffer = Buffer.alloc(0)
  for await (const chunk of chunks) {
    let bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    let text = ''
    if (carry.length > 0) {
      // A lone surrogate split across chunks: finish its three bytes on their own.
      const take = Math.min(3 - carry.length, bytes.length)
      const joined = Buffer.from([...carry, ...bytes.subarray(0, take)])
      bytes = bytes.subarray(take)
      carry = joined.length < 3 && surrogatePrefixLength(joined) === joined.length ? joined : EMPTY
      if (carry !== joined) {
        text += decoder.write(replaceLoneSurrogates(joined))
      }
    }
    if (carry.length === 0) {
      const held = surrogatePrefixLength(bytes)
      carry = held > 0 ? Buffer.from(bytes.subarray(bytes.length - held)) : EMPTY
      text += decoder.write(replaceLoneSurrogates(bytes.subarray(0, bytes.length - held)))
    }
    if (text) {
      yield text
    }
  }
  const rest = decoder.write(carry) + decoder.end()
  if (rest) {
    yield rest
  }
}

const EMPTY = Buffer.alloc(0)

function surrogatePrefixLength(bytes: Buffer): number {
  const last = bytes.length - 1
  if (last < 0) {
    return 0
  }
  if (bytes[last] === 0xed) {
    return 1
  }
  return last >= 1 && bytes[last - 1] === 0xed && (bytes[last] & 0xe0) === 0xa0 ? 2 : 0
}

function replaceLoneSurrogates(bytes: Buffer): Buffer {
  for (let index = 0; index + 2 < bytes.length; index++) {
    if (
      bytes[index] === 0xed &&
      (bytes[index + 1] & 0xe0) === 0xa0 &&
      (bytes[index + 2] & 0xc0) === 0x80
    ) {
      bytes[index] = 0xef
      bytes[index + 1] = 0xbf
      bytes[index + 2] = 0xbd
      index += 2
    }
  }
  return bytes
}
