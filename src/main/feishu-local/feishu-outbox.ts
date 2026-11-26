import type { ConnectorReplyJournal } from '../connector-cloud/connector-reply-outbox'
import { outcomeSentence } from '../connector-cloud/connector-reply-outcome-sentence'
import { dmKey, type Binding } from './feishu-binding'
import { replyFeishu, uploadFeishuFile } from './feishu-replies'
import type { FeishuStore } from './feishu-store-ops'
import type { FeishuCardDelivery } from './feishu-card-delivery'
import { drainFeishuTextOutbox } from './feishu-text-outbox'

/** The journal owns one answer; the response store follows its latest accepted continuation. */
export async function drainFeishuOutbox(
  journal: ConnectorReplyJournal,
  inbox: FeishuStore,
  b: Binding,
  signal: AbortSignal,
  active: () => boolean,
  checkProfile: () => Promise<void>,
  changed: () => void,
  botName: string,
  cards: FeishuCardDelivery
): Promise<void> {
  if (!b.chat) {
    return
  }
  cards.name = botName
  await drainFeishuTextOutbox(inbox, b, active, checkProfile, changed, cards)
  const handedOff = new Set<string>()
  let after: string | null = null
  do {
    const rows = await journal.readOwed(b.account, after, 32)
    for (const row of rows) {
      after = row.deliveryId
      if (!active()) {
        return
      }
      const route = await inbox.messageRoute(b.account, row.deliveryId)
      const chat = route?.chat ?? b.chat
      const fill = row.fill
      if (
        !fill ||
        row.account !== b.account ||
        row.conversation.source !== 'feishu-local' ||
        (row.conversation.externalId !== dmKey(b).externalId &&
          !(await inbox.laneRoute(b.account, row.conversation.externalId)))
      ) {
        continue
      }
      if (await inbox.pendingChoice(b.account, row.deliveryId)) {
        continue
      }
      if (fill.turnItemId && !handedOff.has(fill.answerDeliveryId)) {
        const siblings = await journal.read(row.sessionId)
        for (const sibling of siblings) {
          if (
            sibling.account === b.account &&
            sibling.conversation.source === 'feishu-local' &&
            sibling.conversation.externalId === row.conversation.externalId &&
            sibling.fill?.answerDeliveryId === fill.answerDeliveryId &&
            sibling.fill.turnItemId === fill.turnItemId &&
            sibling.deliveryId !== fill.answerDeliveryId
          ) {
            await inbox.updateResponse(
              b.account,
              row.conversation.externalId,
              sibling.deliveryId,
              chat,
              {
                kind: 'handoff',
                from: fill.answerDeliveryId,
                turnItemId: fill.turnItemId,
                at: Date.now()
              }
            )
          }
        }
        handedOff.add(fill.answerDeliveryId)
      }
      if (fill.answerDeliveryId !== row.deliveryId) {
        await journal.sent([{ account: b.account, deliveryId: row.deliveryId }])
        continue
      }
      if (fill.answerDeliveryId === row.deliveryId && fill.outcome !== 'quiet') {
        await checkProfile()
        if (!active()) {
          return
        }
        const artifact = await inbox.artifact(b.account, row.deliveryId)
        if (!active()) {
          return
        }
        if (artifact && fill.outcome === 'answered' && !artifact.posted) {
          const key =
            artifact.key ?? (await uploadFeishuFile(b.app, artifact.name, artifact.bytes, signal))
          if (!active()) {
            return
          }
          if (!artifact.key) {
            await inbox.uploaded(b.account, row.deliveryId, key)
          }
          if (!active()) {
            return
          }
          await replyFeishu(
            b.app,
            b.account,
            await inbox.replyMessage(b.account, row.deliveryId),
            chat,
            { type: 'file', content: { file_key: key } },
            'file',
            signal
          )
          await inbox.filePosted(b.account, row.deliveryId)
        }
        if (!active()) {
          return
        }
      }
      const id = await inbox.updateResponse(
        b.account,
        row.conversation.externalId,
        row.deliveryId,
        chat,
        {
          kind: 'final',
          turnItemId: fill.turnItemId ?? undefined,
          text:
            fill.answerDeliveryId === row.deliveryId && fill.outcome !== 'quiet'
              ? fill.prose || outcomeSentence(fill.outcome, 'Orca')
              : '',
          failed: fill.outcome === 'failed'
        }
      )
      if (!id || !(await cards.publish(id))) {
        changed()
        continue
      }
      await journal.sent([{ account: b.account, deliveryId: row.deliveryId }])
    }
    if (rows.length < 32) {
      break
    }
  } while (!signal.aborted)
}
