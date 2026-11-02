import { iterateBrowserTextInsertionChunks } from '../../shared/browser-text-insertion-chunks'
import { yieldToEventLoop } from '../../shared/event-loop-yield'
import type { CdpCommandSender } from './snapshot-engine'

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
