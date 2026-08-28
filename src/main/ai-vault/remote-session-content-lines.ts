import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'

const REMOTE_CONTENT_YIELD_LINE_COUNT = 200
const REMOTE_CONTENT_YIELD_CHAR_COUNT = 256 * 1024

/** Splits transcript content into lines. Without a signal there is nothing to
 * observe, so it splits in one pass; with one it yields to the event loop so a
 * cancelled scan stops mid-transcript instead of parsing megabytes for a caller
 * that already left. */
export function remoteSessionContentLines(
  content: string,
  signal?: AbortSignal
): Iterable<string> | AsyncIterable<string> {
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
      continue
    }
    const lineEnd = index > lineStart && content.charCodeAt(index - 1) === 13 ? index - 1 : index
    yield content.slice(lineStart, lineEnd)
    lineStart = index + 1
    linesSinceYield++
    if (
      linesSinceYield >= REMOTE_CONTENT_YIELD_LINE_COUNT ||
      index - yieldStart >= REMOTE_CONTENT_YIELD_CHAR_COUNT
    ) {
      throwIfAiVaultScanCancelled(signal)
      await yieldToEventLoop()
      throwIfAiVaultScanCancelled(signal)
      linesSinceYield = 0
      yieldStart = index
    }
  }
}
