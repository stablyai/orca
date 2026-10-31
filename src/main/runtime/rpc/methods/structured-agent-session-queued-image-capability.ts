// Older readers cannot edit images: retain their ordinary source row and exact idle-only controls.
import type {
  AgentSessionHistoryResult,
  AgentSessionQueuedMessage
} from '../../../../shared/agent-session-wire'
import type { QueuePublication } from '../../../native-chat/agent-session-wire/structured-agent-session-queued-publication'
import { AGENT_SESSION_QUEUED_IMAGE_CARDS_CLIENT_CAPABILITY } from '../../../../shared/protocol-version'
import type { RpcContext } from '../core'
import {
  queuedCardHoldsImage,
  queuedImageSourceIds,
  queuedImageReaderSnapshot,
  queuedImageReaderEvent
} from '../../../native-chat/agent-session-wire/agent-session-queued-image-reader'
import { CLIENT_HISTORY_READER } from '../../../native-chat/agent-session-wire/agent-session-item-wire-form'
import { utf8Head } from '../../../native-chat/agent-session-journal/journal-payload-bounds'

type QueuedImageReader = Pick<RpcContext, 'clientKind' | 'clientCapabilities'>
export function readsQueuedImageCards(ctx: QueuedImageReader): boolean {
  return (
    ctx.clientKind === undefined ||
    ctx.clientCapabilities?.includes(AGENT_SESSION_QUEUED_IMAGE_CARDS_CLIENT_CAPABILITY) === true
  )
}

export function queuedImageHistoryReader(ctx: QueuedImageReader) {
  return readsQueuedImageCards(ctx)
    ? undefined
    : {
        ...CLIENT_HISTORY_READER,
        snapshot: queuedImageReaderSnapshot,
        queueSourceIds: queuedImageSourceIds
      }
}
export function queuedImageSubscriber(ctx: QueuedImageReader) {
  return readsQueuedImageCards(ctx)
    ? {}
    : {
        readHistorySnapshot: queuedImageReaderSnapshot,
        readQueueSourceIds: queuedImageSourceIds,
        projectJournalEvent: queuedImageReaderEvent
      }
}

function oldImageControl(card: AgentSessionQueuedMessage): AgentSessionQueuedMessage {
  if (!queuedCardHoldsImage(card)) {
    return card
  }
  return {
    ...card,
    body: {
      ...card.body,
      command: { name: 'compact' },
      blocks: [
        {
          type: 'text',
          text: utf8Head(
            card.body.blocks
              .flatMap((block) =>
                block.type === 'text'
                  ? [block.text]
                  : block.type === 'image-ref'
                    ? [block.alt ?? block.path ?? block.url ?? 'Image']
                    : []
              )
              .join('\n'),
            2048
          )
        }
      ]
    }
  }
}
export function projectQueuedImageCardHistory(
  result: AgentSessionHistoryResult,
  ctx: QueuedImageReader
): AgentSessionHistoryResult {
  return readsQueuedImageCards(ctx) || !result.page.queuedMessages
    ? result
    : {
        ...result,
        page: { ...result.page, queuedMessages: result.page.queuedMessages.map(oldImageControl) }
      }
}
export function projectQueuedImageCardPublication(
  publication: QueuePublication,
  ctx: QueuedImageReader
): QueuePublication {
  return readsQueuedImageCards(ctx)
    ? publication
    : { ...publication, queuedMessages: publication.queuedMessages.map(oldImageControl) }
}
