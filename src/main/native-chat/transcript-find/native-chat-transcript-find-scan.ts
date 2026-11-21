import type { NativeChatFindDocument } from '../../../shared/native-chat/find/native-chat-session-find'
import {
  countNativeChatFindSegments,
  foldNativeChatFindQuery,
  nativeChatFindSegments,
  nativeChatFindSourceMayMatch,
  nativeChatFindSourceText
} from '../../../shared/native-chat/find/native-chat-find-text'
import type { NativeChatLineDecoder } from '../transcript-decoding/native-chat-line-decoder'
import { transcriptFallbackId } from '../transcript-streaming/transcript-fallback-id'
import { MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES } from '../transcript-decoding/transcript-record-limit'

/** A message find can match: its id and the words it draws, in chat order. */
export type NativeChatFindSource = { entryId: string; text: string }

/** Decodes a transcript fed front to back, as the chat's reader decodes it, keeping only the
 *  user and assistant words find searches. */
export class NativeChatTranscriptFindScan {
  private carry: Buffer[] = []
  private carryBytes = 0
  private lineStart = 0
  private readonly byId = new Map<string, number>()
  readonly sources: NativeChatFindSource[] = []
  textBytes = 0

  constructor(
    private readonly filePath: string,
    private readonly decode: NativeChatLineDecoder
  ) {}

  push(bytes: Buffer): void {
    let from = 0
    for (let at = bytes.indexOf(0x0a); at !== -1; at = bytes.indexOf(0x0a, from)) {
      this.retain(bytes.subarray(from, at))
      this.decodeLine()
      this.lineStart += this.carryBytes + 1
      this.reset()
      from = at + 1
    }
    this.retain(bytes.subarray(from))
  }

  end(): NativeChatFindSource[] {
    this.decodeLine()
    this.reset()
    return this.sources
  }

  private retain(part: Buffer): void {
    this.carryBytes += part.length
    if (this.carryBytes <= MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES && part.length > 0) {
      this.carry.push(part)
    }
  }

  private reset(): void {
    this.carry = []
    this.carryBytes = 0
  }

  private decodeLine(): void {
    // The reader skips oversized records, so the chat never shows them.
    if (this.carryBytes === 0 || this.carryBytes > MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES) {
      return
    }
    let line = (
      this.carry.length === 1 ? this.carry[0]! : Buffer.concat(this.carry, this.carryBytes)
    ).toString('utf8')
    if (line.endsWith('\r')) {
      line = line.slice(0, -1)
    }
    let message
    try {
      message = this.decode(line, transcriptFallbackId(this.filePath, this.lineStart))
    } catch {
      return
    }
    const text = message ? nativeChatFindSourceText(message) : null
    if (!message || text === null) {
      return
    }
    // A record that rewrites an id replaces that row in place, as the reader's assembly does.
    const existing = this.byId.get(message.id)
    if (existing === undefined) {
      this.byId.set(message.id, this.sources.length)
      this.sources.push({ entryId: message.id, text })
    } else {
      this.textBytes -= this.sources[existing]!.text.length
      this.sources[existing] = { entryId: message.id, text }
    }
    this.textBytes += text.length
  }
}

export function countNativeChatFindSources(
  sources: readonly NativeChatFindSource[],
  query: string
): NativeChatFindDocument[] {
  const folded = foldNativeChatFindQuery(query)
  return sources.map(({ entryId, text }) => ({
    entryId,
    count: nativeChatFindSourceMayMatch(text, folded)
      ? countNativeChatFindSegments(nativeChatFindSegments(text), folded)
      : 0
  }))
}
