import type { Readable } from 'node:stream'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { transcriptFallbackId } from './transcript-fallback-id'
import { TranscriptRecordBuffer } from './transcript-record-buffer'
import { MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES } from './transcript-tail-reader'
import { TranscriptMessageRetention } from './transcript-message-retention'

type TranscriptDecoder = (line: string, fallbackId: string) => NativeChatMessage | null

export async function decodeTranscriptStream(
  stream: Readable,
  filePath: string,
  start: number,
  decode: TranscriptDecoder,
  includeTrailingLine: boolean
): Promise<{ messages: NativeChatMessage[]; consumedBytes: number }> {
  const messages = new TranscriptMessageRetention()
  const pending = new TranscriptRecordBuffer(MAX_NATIVE_CHAT_TRANSCRIPT_RECORD_BYTES)
  let consumedBytes = 0

  for await (const chunk of stream) {
    const bytes =
      typeof chunk === 'string'
        ? Buffer.from(chunk, 'utf8')
        : Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk)
    let segmentStart = 0
    let newlineIndex = bytes.indexOf(0x0a)
    while (newlineIndex !== -1) {
      pending.append(bytes.subarray(segmentStart, newlineIndex))
      if (!pending.isOversized) {
        decodeLine(pending.toString(), consumedBytes)
      }
      consumedBytes += pending.byteLength + 1
      pending.clear()
      segmentStart = newlineIndex + 1
      newlineIndex = bytes.indexOf(0x0a, segmentStart)
    }
    if (segmentStart < bytes.length) {
      pending.append(bytes.subarray(segmentStart))
    }
  }

  if (includeTrailingLine && pending.byteLength > 0) {
    if (!pending.isOversized) {
      decodeLine(pending.toString(), consumedBytes)
    }
    consumedBytes += pending.byteLength
  }

  return { messages: messages.values(), consumedBytes }

  function decodeLine(rawLine: string, relativeOffset: number): void {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line) {
      return
    }
    const message = decode(line, transcriptFallbackId(filePath, start + relativeOffset))
    if (message) {
      messages.add(message, Buffer.byteLength(line, 'utf8'))
    }
  }
}
