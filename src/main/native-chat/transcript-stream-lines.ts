import type { Readable } from 'node:stream'
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
  let pending = ''
  let consumedBytes = 0

  for await (const chunk of stream) {
    pending += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    let newlineIndex = pending.indexOf('\n')
    while (newlineIndex !== -1) {
      const segment = pending.slice(0, newlineIndex + 1)
      decodeLine(segment.slice(0, -1), consumedBytes)
      consumedBytes += Buffer.byteLength(segment, 'utf8')
      pending = pending.slice(newlineIndex + 1)
      newlineIndex = pending.indexOf('\n')
    }
  }

  if (includeTrailingLine && pending.length > 0) {
    decodeLine(pending, consumedBytes)
    consumedBytes += Buffer.byteLength(pending, 'utf8')
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
