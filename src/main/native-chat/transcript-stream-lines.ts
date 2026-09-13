import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { transcriptFallbackId } from './transcript-fallback-id'

type TranscriptDecoder = (line: string, fallbackId: string) => NativeChatMessage | null

export async function decodeTranscriptStream(
  stream: Readable,
  filePath: string,
  start: number,
  decode: TranscriptDecoder,
  includeTrailingLine: boolean
): Promise<{ messages: NativeChatMessage[]; consumedBytes: number }> {
  const messages: NativeChatMessage[] = []
  // Why: a Buffer chunk can end mid-codepoint, and decoding it standalone would
  // both corrupt the line and shift `consumedBytes` (which seeds fallback ids).
  const decoder = new StringDecoder('utf8')
  let pending: string[] = []
  let consumedBytes = 0

  for await (const chunk of stream) {
    const text = typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk))
    // Only the new chunk is scanned; partial records wait in `pending` unrescanned.
    let lineStart = 0
    let newlineIndex = text.indexOf('\n')
    while (newlineIndex !== -1) {
      let segment = text.slice(lineStart, newlineIndex + 1)
      if (pending.length > 0) {
        // Join a fragmented record only once, including split string surrogate pairs.
        pending.push(segment)
        segment = pending.join('')
        pending = []
      }
      decodeLine(segment.slice(0, -1), consumedBytes)
      consumedBytes += Buffer.byteLength(segment, 'utf8')
      lineStart = newlineIndex + 1
      newlineIndex = text.indexOf('\n', lineStart)
    }
    if (lineStart < text.length) {
      pending.push(text.slice(lineStart))
    }
  }
  const tail = decoder.end()
  if (tail) {
    pending.push(tail)
  }

  if (includeTrailingLine && pending.length > 0) {
    const line = pending.join('')
    decodeLine(line, consumedBytes)
    consumedBytes += Buffer.byteLength(line, 'utf8')
  }

  return { messages, consumedBytes }

  function decodeLine(rawLine: string, relativeOffset: number): void {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line) {
      return
    }
    const message = decode(line, transcriptFallbackId(filePath, start + relativeOffset))
    if (message) {
      messages.push(message)
    }
  }
}
