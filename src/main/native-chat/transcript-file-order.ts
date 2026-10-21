import type { NativeChatMessage } from '../../shared/native-chat-types'

/** Desktop orders terminal transcript rows by time, but the file holds the true order:
 *  Claude stamps a prompt it took mid-turn with when it was queued, then writes it
 *  where it read it. So a row never sorts above the rows before it. `latest` is the
 *  newest time above this row; returns the row and the newest time including it. */
export function inTranscriptFileOrder(
  message: NativeChatMessage,
  latest: number
): { message: NativeChatMessage; latest: number } {
  if (message.timestamp === null || message.timestamp >= latest) {
    return { message, latest: Math.max(latest, message.timestamp ?? latest) }
  }
  // Why: one past, not equal: equal times fall back to id order, which can still put it first.
  const timestamp = latest + 1
  return { message: { ...message, timestamp }, latest: timestamp }
}
