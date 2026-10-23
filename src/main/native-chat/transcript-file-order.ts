import {
  hasImagePromptMarker,
  isImageSourceUserTurn
} from '../../shared/native-chat-image-transcript-markers'
import type { NativeChatMessage } from '../../shared/native-chat-types'

type ImagePairPart = 'source' | 'prompt'

/** What a row's order depends on: the newest time above it and, when the row right above is a
 *  pasted-image prompt or image row, that row's part and its file and ordered times. */
export type TranscriptFileOrder = {
  latest: number
  imageRowAbove?: { part: ImagePairPart; timestamp: number; ordered: number }
}

export const TRANSCRIPT_FILE_ORDER_START: TranscriptFileOrder = {
  latest: Number.NEGATIVE_INFINITY
}

/** Desktop orders terminal transcript rows by time, but the file holds the true order:
 *  Claude stamps a prompt it took mid-turn with when it was queued, then writes it
 *  where it read it, and a CLI may stamp every row of one response alike. So a row never
 *  sorts above the rows before it. Returns the row and the order the next row continues from. */
export function inTranscriptFileOrder(
  message: NativeChatMessage,
  order: TranscriptFileOrder
): { message: NativeChatMessage; order: TranscriptFileOrder } {
  const { timestamp } = message
  if (timestamp === null) {
    return { message, order: { latest: order.latest } }
  }
  const part = imagePairPart(message)
  const ordered = orderedTimestamp(timestamp, order.latest, part, order.imageRowAbove)
  return {
    message: ordered === timestamp ? message : { ...message, timestamp: ordered },
    order: {
      latest: Math.max(order.latest, ordered),
      ...(part ? { imageRowAbove: { part, timestamp, ordered } } : {})
    }
  }
}

function imagePairPart(message: NativeChatMessage): ImagePairPart | undefined {
  if (message.role !== 'user') {
    return undefined
  }
  if (isImageSourceUserTurn(message)) {
    return 'source'
  }
  return hasImagePromptMarker(message) ? 'prompt' : undefined
}

function orderedTimestamp(
  timestamp: number,
  latest: number,
  part: ImagePairPart | undefined,
  imageRowAbove: TranscriptFileOrder['imageRowAbove']
): number {
  // Why: Claude stamps a pasted-image prompt and its image rows alike, and the chat pairs them by
  // that time, so a pair moved below earlier rows moves together.
  if (
    part &&
    imageRowAbove?.timestamp === timestamp &&
    (part === 'source' || imageRowAbove.part === 'source')
  ) {
    return imageRowAbove.ordered
  }
  // Why: one past, not equal: equal times fall back to id order, which can still put it first.
  return timestamp > latest ? timestamp : latest + 1
}
