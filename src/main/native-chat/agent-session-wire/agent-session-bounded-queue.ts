// Never shorten editable cards: send the longest whole prefix that fits so saving cannot lose hidden text.

import { BOUNDED_FRAME_CONTENT_BUDGET_BYTES } from './agent-session-history-page-bounds'
import { jsonBytes } from './json-string-shortening'
import type { QueuePublication } from './structured-agent-session-queued-publication'

export function boundedQueuePublication(publication: QueuePublication): QueuePublication {
  const cards = publication.queuedMessages
  let bytes = 2
  let count = 0
  for (const card of cards) {
    const next = jsonBytes(card) + (count ? 1 : 0)
    if (bytes + next > BOUNDED_FRAME_CONTENT_BUDGET_BYTES) {
      break
    }
    bytes += next
    count++
  }
  return count === cards.length
    ? publication
    : { ...publication, queuedMessages: cards.slice(0, count) }
}
