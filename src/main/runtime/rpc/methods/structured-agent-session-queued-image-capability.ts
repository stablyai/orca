import { finishJournalSteps } from '../../../native-chat/agent-session-journal/journal-reconstruction-steps'
import type { AgentSessionHistoryResult } from '../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session/requests/agent-session-queued-message-wire'
import type { QueuePublication } from '../../../native-chat/agent-session-wire/structured-agent-session-queued-publication'
import { AGENT_SESSION_QUEUED_IMAGE_CARDS_CLIENT_CAPABILITY } from '../../../../shared/agent-session/agent-session-runtime-capabilities'
import type { RpcContext } from '../core'
import {
  queuedCardHoldsImage,
  queuedImageSourceIds,
  queuedImageReaderSnapshot,
  queuedImageReaderSnapshotSteps,
  queuedImageReaderEvent,
  queuedImageReaderEventSteps
} from '../../../native-chat/agent-session-wire/agent-session-queued-image-reader'
import { CLIENT_HISTORY_READER } from '../../../native-chat/agent-session-wire/agent-session-item-wire-form'
import { utf8Head } from '../../../native-chat/agent-session-journal/journal-payload-bounds'
// Older readers retain the ordinary image source and their supported controls.

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
        snapshotSteps: queuedImageReaderSnapshotSteps,
        queueSourceIds: queuedImageSourceIds
      }
}
export function queuedImageSubscriber(ctx: QueuedImageReader) {
  return readsQueuedImageCards(ctx)
    ? {}
    : {
        readHistorySnapshot: queuedImageReaderSnapshot,
        readHistorySnapshotSteps: queuedImageReaderSnapshotSteps,
        readQueueSourceIds: queuedImageSourceIds,
        projectJournalEvent: queuedImageReaderEvent,
        projectJournalEventSteps: queuedImageReaderEventSteps
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
  return finishJournalSteps(projectQueuedImageCardHistorySteps(result, ctx))
}
export function* projectQueuedImageCardHistorySteps(
  result: AgentSessionHistoryResult,
  ctx: QueuedImageReader
): Generator<void, AgentSessionHistoryResult> {
  if (readsQueuedImageCards(ctx) || !result.page.queuedMessages) {
    return result
  }
  const queuedMessages: AgentSessionQueuedMessage[] = []
  for (const card of result.page.queuedMessages) {
    queuedMessages.push(oldImageControl(card))
    yield
  }
  return { ...result, page: { ...result.page, queuedMessages } }
}
export function projectQueuedImageCardPublication(
  publication: QueuePublication,
  ctx: QueuedImageReader
): QueuePublication {
  return finishJournalSteps(projectQueuedImageCardPublicationSteps(publication, ctx))
}

export function* projectQueuedImageCardPublicationSteps(
  publication: QueuePublication,
  ctx: QueuedImageReader
): Generator<void, QueuePublication> {
  if (readsQueuedImageCards(ctx)) {
    return publication
  }
  const queuedMessages: AgentSessionQueuedMessage[] = []
  for (const card of publication.queuedMessages) {
    queuedMessages.push(oldImageControl(card))
    yield
  }
  return { ...publication, queuedMessages }
}
