// Never shorten editable cards: send the longest whole prefix that fits so saving cannot lose hidden text.

import { BOUNDED_FRAME_CONTENT_BUDGET_BYTES } from './agent-session-history-page-bounds'
import { jsonBytes } from './json-string-shortening'
import type { QueuePublication } from './structured-agent-session-queued-publication'

export function boundedQueuePublication(publication: QueuePublication): QueuePublication {
  const cards = publication.queuedMessages
  if (jsonBytes(cards) <= BOUNDED_FRAME_CONTENT_BUDGET_BYTES) {
    return publication
  }
  let fits = 0
  let fitsNot = cards.length
  while (fitsNot - fits > 1) {
    const middle = Math.floor((fits + fitsNot) / 2)
    if (jsonBytes(cards.slice(0, middle)) <= BOUNDED_FRAME_CONTENT_BUDGET_BYTES) {
      fits = middle
    } else {
      fitsNot = middle
    }
  }
  return { ...publication, queuedMessages: cards.slice(0, fits) }
}
