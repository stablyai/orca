import type { Readable } from 'node:stream'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { transcriptFallbackId } from './transcript-fallback-id'

type TranscriptDecoder = (line: string, fallbackId: string) => NativeChatMessage | null

export type TranscriptDecodeLimits = {
  /** Maximum UTF-8 bytes accepted from the decoded stream. */
  maxDecodedBytes?: number
  /** Maximum UTF-8 bytes accepted in one JSONL record. */
  maxLineBytes?: number
  /** Keep only the newest decoded messages while continuing to scan the stream. */
  maxMessages?: number
}

export class TranscriptDecodeLimitError extends Error {
  constructor(kind: 'decoded byte' | 'line byte', limit: number) {
    super(`Transcript ${kind} limit exceeded (${limit} bytes)`)
    this.name = 'TranscriptDecodeLimitError'
  }
}

export async function decodeTranscriptStream(
  stream: Readable,
  filePath: string,
  start: number,
  decode: TranscriptDecoder,
  includeTrailingLine: boolean,
  limits: TranscriptDecodeLimits = {}
): Promise<{ messages: NativeChatMessage[]; consumedBytes: number }> {
  const messages: NativeChatMessage[] = []
  let pending = ''
  let pendingBytes = 0
  let decodedBytes = 0
  let consumedBytes = 0
  let oldestMessageIndex = 0

  assertPositiveLimit(limits.maxDecodedBytes, 'decoded byte')
  assertPositiveLimit(limits.maxLineBytes, 'line byte')
  assertPositiveLimit(limits.maxMessages, 'message')

  for await (const chunk of stream) {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    const chunkBytes = typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.length
    decodedBytes += chunkBytes
    if (limits.maxDecodedBytes !== undefined && decodedBytes > limits.maxDecodedBytes) {
      throw new TranscriptDecodeLimitError('decoded byte', limits.maxDecodedBytes)
    }
    pending += text
    pendingBytes += Buffer.byteLength(text, 'utf8')
    let newlineIndex = pending.indexOf('\n')
    while (newlineIndex !== -1) {
      const segment = pending.slice(0, newlineIndex + 1)
      decodeLine(segment.slice(0, -1), consumedBytes)
      const segmentBytes = Buffer.byteLength(segment, 'utf8')
      consumedBytes += segmentBytes
      pending = pending.slice(newlineIndex + 1)
      pendingBytes -= segmentBytes
      newlineIndex = pending.indexOf('\n')
    }
    enforceLineLimit(pendingBytes)
  }

  if (includeTrailingLine && pending.length > 0) {
    enforceLineLimit(pendingBytes)
    decodeLine(pending, consumedBytes)
    consumedBytes += Buffer.byteLength(pending, 'utf8')
  }

  const orderedMessages =
    oldestMessageIndex === 0
      ? messages
      : messages.slice(oldestMessageIndex).concat(messages.slice(0, oldestMessageIndex))
  return { messages: orderedMessages, consumedBytes }

  function decodeLine(rawLine: string, relativeOffset: number): void {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line) {
      return
    }
    enforceLineLimit(Buffer.byteLength(line, 'utf8'))
    const message = decode(line, transcriptFallbackId(filePath, start + relativeOffset))
    if (message) {
      if (limits.maxMessages === undefined || messages.length < limits.maxMessages) {
        messages.push(message)
      } else {
        messages[oldestMessageIndex] = message
        oldestMessageIndex = (oldestMessageIndex + 1) % limits.maxMessages
      }
    }
  }

  function enforceLineLimit(bytes: number): void {
    if (limits.maxLineBytes !== undefined && bytes > limits.maxLineBytes) {
      throw new TranscriptDecodeLimitError('line byte', limits.maxLineBytes)
    }
  }
}

function assertPositiveLimit(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`Transcript ${name} limit must be a positive safe integer`)
  }
}
