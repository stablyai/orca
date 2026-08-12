// Single-sources the marker logic (pure functions over shared types):
// Claude records an attached image as `[Image: source: /path]` (+ `[Image #N]`
// prefix on the caption turn), and both render and echo reconciliation must
// agree with desktop on how those marker turns are interpreted.
export {
  imageSourcePathFromText,
  normalizeImageTranscriptMessages,
  stripImagePromptMarker
} from '../../../src/shared/native-chat-image-transcript-markers'
import { imageSourcePathFromText } from '../../../src/shared/native-chat-image-transcript-markers'
import { isTextBlock, type NativeChatMessage } from '../../../src/shared/native-chat-types'

/** A raw (un-normalized) transcript user turn that is an image-source marker —
 *  the echo shape of an image riding along on a send. */
export function isImageSourceUserTurn(message: NativeChatMessage): boolean {
  if (message.role !== 'user' || message.blocks.length !== 1) {
    return false
  }
  const block = message.blocks[0]
  return block !== undefined && isTextBlock(block) && imageSourcePathFromText(block.text) !== null
}
