import type { NativeChatMessage } from '../../shared/native-chat-types'

/** Raise timestamps to preserve file order: Claude may write queued prompts after later-dated tool results. */
export function inTranscriptFileOrder(
  message: NativeChatMessage,
  latest: number
): { message: NativeChatMessage; latest: number } {
  if (message.timestamp === null || message.timestamp >= latest) {
    return { message, latest: Math.max(latest, message.timestamp ?? latest) }
  }
  // Equal timestamps sort by ID, so advance at least one millisecond.
  const timestamp = latest + 1
  return { message: { ...message, timestamp }, latest: timestamp }
}
