// A reader that predates image cards shows a card's text only, and edits by copying that text and
// deleting the card, which would drop its images. It is never handed a card holding an image, at
// the RPC boundary only: the journal, the drain and every in-process reader keep the whole queue.

import type {
  AgentSessionHistoryResult,
  AgentSessionQueuedMessage,
  AgentSessionQueuePublicationFields
} from '../../../../shared/agent-session-wire'
import type { QueuePublication } from '../../../native-chat/agent-session-wire/structured-agent-session-queued-publication'
import { AGENT_SESSION_QUEUED_IMAGE_CARDS_CLIENT_CAPABILITY } from '../../../../shared/protocol-version'
import type { RpcContext } from '../core'

type QueuedImageReader = Pick<RpcContext, 'clientKind' | 'clientCapabilities'>

type QueueFields = AgentSessionQueuePublicationFields & {
  queuedMessages?: AgentSessionQueuedMessage[] | null
}

export function readsQueuedImageCards(ctx: QueuedImageReader): boolean {
  // An in-process caller is this build; only a negotiated client can predate image cards.
  return (
    ctx.clientKind === undefined ||
    ctx.clientCapabilities?.includes(AGENT_SESSION_QUEUED_IMAGE_CARDS_CLIENT_CAPABILITY) === true
  )
}

function holdsImage(card: AgentSessionQueuedMessage): boolean {
  return card.body.blocks.some((block) => block.type === 'image-ref')
}

/** The fields to replace, or null when nothing is withheld. Positions and the next card's id stay
 *  as published, as when a phone's frame trims the list. A pause over no card the reader sees would
 *  offer a Resume that sends nothing it shows. */
function withoutImageCards(
  fields: QueueFields
):
  | (Pick<QueuePublication, 'queuedMessages'> & Partial<Pick<QueuePublication, 'queuePause'>>)
  | null {
  const cards = fields.queuedMessages
  if (!cards?.some(holdsImage)) {
    return null
  }
  const queuedMessages = cards.filter((card) => !holdsImage(card))
  return {
    queuedMessages,
    ...(queuedMessages.length === 0 && fields.queuePause !== undefined ? { queuePause: null } : {})
  }
}

export function projectQueuedImageCardHistory(
  result: AgentSessionHistoryResult,
  ctx: QueuedImageReader
): AgentSessionHistoryResult {
  const page = readsQueuedImageCards(ctx) ? null : withoutImageCards(result.page)
  return page ? { ...result, page: { ...result.page, ...page } } : result
}

/** Applied before subscriber frame sizing; the host's canonical publication stays unchanged. */
export function projectQueuedImageCardPublication(
  publication: QueuePublication,
  ctx: QueuedImageReader
): QueuePublication {
  const fields = readsQueuedImageCards(ctx) ? null : withoutImageCards(publication)
  return fields ? { ...publication, ...fields } : publication
}
