// The draft queue as a bounded-frame subscriber receives it: whole, or when the list outgrows the
// rows' share of a frame, the cards it sends first, whole; the rest show once those leave. A card is
// never shortened: a reader that edits one replaces the draft with what it holds.

import { BOUNDED_FRAME_CONTENT_BUDGET_BYTES } from './agent-session-history-page-bounds'
import { jsonBytes } from './json-string-shortening'
import type { QueuePublication } from './structured-agent-session-queued-publication'

export function boundedQueuePublication(publication: QueuePublication): QueuePublication {
  const cards = publication.queuedMessages
  if (jsonBytes(cards) <= BOUNDED_FRAME_CONTENT_BUDGET_BYTES) {
    return publication
  }
  // The longest run from the front that fits.
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
