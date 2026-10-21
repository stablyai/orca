import { splitTranscriptStreamLines } from '../native-chat/transcript-stream-lines'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { MAX_SESSION_TRANSCRIPT_RECORD_BYTES } from './session-transcript-record-budget'

export type RemoteSessionContent = string | AsyncIterable<string>

const REMOTE_CONTENT_YIELD_LINE_COUNT = 200
const REMOTE_CONTENT_YIELD_CHAR_COUNT = 256 * 1024

/** Splits transcript content into lines. Without a signal there is nothing to
 * observe, so it splits in one pass; with one it yields to the event loop so a
 * cancelled scan stops mid-transcript instead of parsing megabytes for a caller
 * that already left. */
export function remoteSessionContentLines(
  content: RemoteSessionContent,
  signal?: AbortSignal
): Iterable<string> | AsyncIterable<string> {
  if (typeof content !== 'string') {
    return content
  }
  return signal ? cancellableContentLines(content, signal) : content.split(/\r?\n/)
}

async function* cancellableContentLines(
  content: string,
  signal: AbortSignal
): AsyncGenerator<string> {
  // Content below one yield window would otherwise never observe cancellation.
  throwIfAiVaultScanCancelled(signal)
  let lineStart = 0
  let yieldStart = 0
  let linesSinceYield = 0

  for (let index = 0; index <= content.length; index++) {
    if (index < content.length && content.charCodeAt(index) !== 10) {
      const newline = content.indexOf('\n', index)
      const lineBreak = newline === -1 ? content.length : newline
      // Bound the jump so a newline-free segment still observes cancellation.
      const windowEnd = yieldStart + REMOTE_CONTENT_YIELD_CHAR_COUNT
      if (lineBreak > windowEnd) {
        await yieldUnlessCancelled(signal)
        linesSinceYield = 0
        yieldStart = windowEnd
        // Resume the search at windowEnd itself; the loop increment lands there.
        index = windowEnd - 1
        continue
      }
      index = lineBreak
    }
    const lineEnd = index > lineStart && content.charCodeAt(index - 1) === 13 ? index - 1 : index
    yield content.slice(lineStart, lineEnd)
    lineStart = index + 1
    linesSinceYield++
    if (
      linesSinceYield >= REMOTE_CONTENT_YIELD_LINE_COUNT ||
      index - yieldStart >= REMOTE_CONTENT_YIELD_CHAR_COUNT
    ) {
      await yieldUnlessCancelled(signal)
      linesSinceYield = 0
      yieldStart = index
    }
  }
}

async function yieldUnlessCancelled(signal: AbortSignal): Promise<void> {
  throwIfAiVaultScanCancelled(signal)
  await yieldToEventLoop()
  throwIfAiVaultScanCancelled(signal)
}

export class BinarySessionTranscriptError extends Error {
  constructor() {
    super('Binary session transcript')
  }
}

export async function* streamedSessionContentLines(
  bytes: AsyncIterable<Buffer>,
  signal?: AbortSignal
): AsyncGenerator<string> {
  let count = 0
  let chars = 0
  for await (const record of splitTranscriptStreamLines(
    bytes,
    MAX_SESSION_TRANSCRIPT_RECORD_BYTES
  )) {
    throwIfAiVaultScanCancelled(signal)
    const line =
      record.line.endsWith('\r') && (record.terminated || signal)
        ? record.line.slice(0, -1)
        : record.line
    yield line
    chars += line.length
    if (++count >= REMOTE_CONTENT_YIELD_LINE_COUNT || chars >= REMOTE_CONTENT_YIELD_CHAR_COUNT) {
      await yieldToEventLoop()
      throwIfAiVaultScanCancelled(signal)
      count = 0
      chars = 0
    }
  }
}
