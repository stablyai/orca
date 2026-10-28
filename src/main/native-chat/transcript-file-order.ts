import type { NativeChatMessage } from '../../shared/native-chat-types'

/** Modern readers use record position; legacy readers retain their historical backward-clock clamp. */
export function inTranscriptFileOrder(
  message: NativeChatMessage,
  latest: number,
  sourceOffset?: number
): { message: NativeChatMessage; latest: number } {
  if (sourceOffset !== undefined) {
    return { message: { ...message, transcriptOrder: sourceOffset }, latest }
  }
  if (message.timestamp === null || message.timestamp >= latest) {
    return { message, latest: Math.max(latest, message.timestamp ?? latest) }
  }
  // Equal timestamps sort by ID, so advance at least one millisecond.
  const timestamp = latest + 1
  return { message: { ...message, timestamp }, latest: timestamp }
}
