// Withhold image cards only at RPC for older readers whose copy-text/delete edits would lose images; keep the canonical queue intact.

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

/** Replace visible cards only, preserving positions/next id; hide pause when Resume would send only unseen cards. Null means nothing withheld. */
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
