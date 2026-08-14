import type { NativeChatMessage } from '../../shared/native-chat-types'

/**
 * A queued prompt is stamped when it was enqueued, but the transcript appends it
 * where the agent finally took it — after records that are newer. Sorting by time
 * would lift it back above them, so give it a timestamp just past the record it
 * was written after and let it keep the position the file already assigned.
 *
 * `seedTimestamp` carries that predecessor across reads: a live append batch can
 * start with the queued record itself, and without the previous batch's last
 * timestamp there would be nothing to anchor it to.
 */
export function anchorQueuedPromptsToFileOrder(
  messages: readonly NativeChatMessage[],
  seedTimestamp: number | null = null
): NativeChatMessage[] {
  let previousTimestamp = seedTimestamp
  let changed = false

  const anchored = messages.map((message) => {
    if (!message.queued) {
      previousTimestamp = message.timestamp ?? previousTimestamp
      return message
    }
    // Why: an equal timestamp is not safe either — the sorter breaks those ties
    // on id, which can lift the queued prompt above the record it followed.
    if (
      previousTimestamp === null ||
      message.timestamp === null ||
      message.timestamp > previousTimestamp
    ) {
      previousTimestamp = message.timestamp ?? previousTimestamp
      return message
    }
    // Why: one tick past the predecessor, not equal to it — equal timestamps tie
    // break on id, which would sort the queued prompt back above it.
    const anchoredAt = previousTimestamp + 1
    previousTimestamp = anchoredAt
    changed = true
    return { ...message, timestamp: anchoredAt }
  })

  return changed ? anchored : (messages as NativeChatMessage[])
}

/** Last timestamp a following batch should anchor against. */
export function lastAnchorTimestamp(
  messages: readonly NativeChatMessage[],
  fallback: number | null
): number | null {
  let last = fallback
  for (const message of messages) {
    last = message.timestamp ?? last
  }
  return last
}
