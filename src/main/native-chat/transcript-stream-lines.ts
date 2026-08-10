import type { Readable } from 'node:stream'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import {
  consumeCodexTextMirror,
  isCodexTranscriptDecoder,
  mergeCodexTextMirrorMessages,
  type CodexTextMirrorRecord
} from './transcript-codex-mirror'
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
  const deduplicateCodexMirrors = isCodexTranscriptDecoder(decode)
  let previousCodexRecord: CodexTextMirrorRecord | null = null
  let previousCodexMessage: NativeChatMessage | null = null
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
    const previousRecord = previousCodexRecord
    const previousMessage = previousCodexMessage
    const mirror = deduplicateCodexMirrors ? consumeCodexTextMirror(previousRecord, line) : null
    if (mirror) {
      previousCodexRecord = mirror.current
      previousCodexMessage = mirror.duplicate ? null : message
    }
    if (mirror?.duplicate) {
      const merged = mergeCodexTextMirrorMessages(
        previousRecord,
        previousMessage,
        mirror.candidate,
        message
      )
      const retained = messages.at(-1)
      if (merged && retained && previousMessage && retained.id === previousMessage.id) {
        messages[messages.length - 1] = merged
      } else if (merged && !previousMessage) {
        messages.push(merged)
      }
    } else if (message) {
      messages.push(message)
    }
  }
}
