import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
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
  let pendingHighSurrogate = ''
  const utf8Decoder = new StringDecoder('utf8')

  assertPositiveLimit(limits.maxDecodedBytes, 'decoded byte')
  assertPositiveLimit(limits.maxLineBytes, 'line byte')
  assertPositiveLimit(limits.maxMessages, 'message')

  for await (const chunk of stream) {
    if (typeof chunk === 'string') {
      let text = pendingHighSurrogate + chunk
      pendingHighSurrogate = ''
      const lastCodeUnit = text.charCodeAt(text.length - 1)
      if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
        pendingHighSurrogate = text.slice(-1)
        text = text.slice(0, -1)
      }
      consumeTranscriptBytes(Buffer.from(text, 'utf8'))
      continue
    }
    if (pendingHighSurrogate) {
      consumeTranscriptBytes(Buffer.from(pendingHighSurrogate, 'utf8'))
      pendingHighSurrogate = ''
    }
    consumeTranscriptBytes(Buffer.from(chunk))
  }
  if (pendingHighSurrogate) {
    consumeTranscriptBytes(Buffer.from(pendingHighSurrogate, 'utf8'))
  }

  pending += utf8Decoder.end()
  if (includeTrailingLine && pending.length > 0) {
    enforceLineLimit(pendingBytes)
    decodeLine(pending, consumedBytes, pendingBytes)
    consumedBytes += pendingBytes
  }

  const orderedMessages =
    oldestMessageIndex === 0
      ? messages
      : messages.slice(oldestMessageIndex).concat(messages.slice(0, oldestMessageIndex))
  return { messages: orderedMessages, consumedBytes }

  function consumeTranscriptBytes(bytes: Buffer): void {
    decodedBytes += bytes.length
    if (limits.maxDecodedBytes !== undefined && decodedBytes > limits.maxDecodedBytes) {
      throw new TranscriptDecodeLimitError('decoded byte', limits.maxDecodedBytes)
    }
    let chunkOffset = 0
    let newlineIndex = bytes.indexOf(0x0a)
    while (newlineIndex !== -1) {
      const segment = bytes.subarray(chunkOffset, newlineIndex + 1)
      pending += utf8Decoder.write(segment)
      pendingBytes += segment.length
      decodeLine(pending.slice(0, -1), consumedBytes, pendingBytes - 1)
      consumedBytes += pendingBytes
      pending = ''
      pendingBytes = 0
      chunkOffset = newlineIndex + 1
      newlineIndex = bytes.indexOf(0x0a, chunkOffset)
    }
    const trailing = bytes.subarray(chunkOffset)
    pending += utf8Decoder.write(trailing)
    pendingBytes += trailing.length
    enforceLineLimit(pendingBytes)
  }

  function decodeLine(rawLine: string, relativeOffset: number, rawLineBytes: number): void {
    const hasCarriageReturn = rawLine.endsWith('\r')
    const line = hasCarriageReturn ? rawLine.slice(0, -1) : rawLine
    if (!line) {
      return
    }
    enforceLineLimit(rawLineBytes - (hasCarriageReturn ? 1 : 0))
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
