import { measureClipboardTextByteLength } from '../../shared/clipboard-text'
import { yieldToEventLoop } from '../../shared/event-loop-yield'
import { getUtf8ChunkEndIndex } from '../../shared/utf8-byte-limits'
import type { CdpCommandSender } from './snapshot-engine'

export const BROWSER_TEXT_INSERT_CHUNK_BYTES = 64 * 1024

export function splitBrowserTextInsertionChunks(
  text: string,
  maxChunkBytes = BROWSER_TEXT_INSERT_CHUNK_BYTES
): string[] {
  return [...iterateBrowserTextInsertionChunks(text, maxChunkBytes)]
}

export function* iterateBrowserTextInsertionChunks(
  text: string,
  maxChunkBytes = BROWSER_TEXT_INSERT_CHUNK_BYTES
): Generator<string> {
  if (text.length === 0) {
    return
  }
  const normalizedMax = Number.isFinite(maxChunkBytes) && maxChunkBytes > 0 ? maxChunkBytes : 1
  const measurement = measureClipboardTextByteLength(text, { stopAfterBytes: normalizedMax })
  if (!measurement.exceededLimit) {
    yield text
    return
  }

  let startIndex = 0
  while (startIndex < text.length) {
    const endIndex = getUtf8ChunkEndIndex(text, startIndex, normalizedMax)
    yield text.slice(startIndex, endIndex)
    startIndex = endIndex
  }
}

export async function insertTextThroughCdp(
  sender: CdpCommandSender,
  text: string,
  options?: { yieldBetweenChunks?: boolean; maxChunkBytes?: number }
): Promise<void> {
  const chunks = iterateBrowserTextInsertionChunks(text, options?.maxChunkBytes)
  let chunk = chunks.next()
  while (!chunk.done) {
    await sender('Input.insertText', { text: chunk.value })
    // Keep paste-sized insertion from monopolizing the main process.
    chunk = chunks.next()
    if (options?.yieldBetweenChunks !== false && !chunk.done) {
      await yieldToEventLoop()
    }
  }
}
