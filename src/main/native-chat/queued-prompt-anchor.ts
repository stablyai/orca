import type { NativeChatMessage } from '../../shared/native-chat-types'
import { anchorQueuedPromptsToFileOrder, lastAnchorTimestamp } from './queued-prompt-file-order'

export type QueuedPromptAnchor = {
  /** Anchor a batch and remember what the next one should anchor against. */
  apply: (messages: NativeChatMessage[]) => NativeChatMessage[]
  /** Adopt an already-anchored snapshot as the starting point. */
  adopt: (messages: readonly NativeChatMessage[]) => void
  reset: () => void
}

/**
 * Carries the predecessor timestamp across reads. A live append batch can hold
 * only the queued record, leaving nothing in-batch to anchor against.
 */
export function createQueuedPromptAnchor(): QueuedPromptAnchor {
  let previous: number | null = null
  return {
    apply(messages) {
      const anchored = anchorQueuedPromptsToFileOrder(messages, previous)
      previous = lastAnchorTimestamp(anchored, previous)
      return anchored
    },
    adopt(messages) {
      previous = lastAnchorTimestamp(messages, null)
    },
    reset() {
      previous = null
    }
  }
}
