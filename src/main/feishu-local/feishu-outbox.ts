import type { ConnectorReplyJournal } from '../connector-cloud/connector-reply-outbox'
import { outcomeSentence } from '../connector-cloud/connector-reply-outcome-sentence'
import { dmKey, type Binding } from './feishu-binding'
import { replyFeishu, feishuReplyMessage, uploadFeishuFile } from './feishu-replies'
import type { FeishuStore } from './feishu-store-ops'
import { drainFeishuTextOutbox } from './feishu-text-outbox'

/** Only the delivery named by the native turn's stamps owns the answer. */
export async function drainFeishuOutbox(
  journal: ConnectorReplyJournal,
  inbox: FeishuStore,
  b: Binding,
  signal: AbortSignal,
  active: () => boolean,
  checkProfile: () => Promise<void>,
  changed: () => void,
  botName: string
): Promise<void> {
  if (!b.chat) {
    return
  }
  await drainFeishuTextOutbox(inbox, b, signal, active, checkProfile, changed, botName)
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
      if (fill.answerDeliveryId === row.deliveryId && fill.outcome !== 'quiet') {
        await checkProfile()
        if (!active()) {
          return
        }
        if (!(await inbox.mayPost(b.account, row.deliveryId, Date.now()))) {
          await inbox.review(b.account, row.deliveryId)
          changed()
          continue
        }
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
            row.deliveryId,
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
        const finalId = await replyFeishu(
          b.app,
          b.account,
          row.deliveryId,
          chat,
          feishuReplyMessage(fill.prose || outcomeSentence(fill.outcome, 'Orca'), botName),
          'final',
          signal
        )
        if (route) {
          await inbox.putRoute(b.account, finalId, route)
        }
      }
      await journal.sent([{ account: b.account, deliveryId: row.deliveryId }])
    }
    if (rows.length < 32) {
      break
    }
  } while (!signal.aborted)
}
