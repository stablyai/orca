import type { ConnectorReplyJournal } from '../connector-cloud/connector-reply-outbox'
import { outcomeSentence } from '../connector-cloud/connector-reply-outbox'
import { dmKey, type Binding } from './feishu-binding'
import { replyFeishu } from './feishu-cli'
import type { FeishuStore } from './feishu-store-ops'

/** Only the delivery named by the native turn's stamps owns the answer. */
export async function drainFeishuOutbox(
  journal: ConnectorReplyJournal,
  inbox: FeishuStore,
  b: Binding,
  signal: AbortSignal,
  active: () => boolean,
  checkProfile: () => Promise<void>,
  changed: () => void
): Promise<void> {
  if (!b.chat) {
    return
  }
  let after: string | null = null
  do {
    const rows = await journal.readOwed(b.account, after, 32)
    for (const row of rows) {
      after = row.deliveryId
      if (!active()) {
        return
      }
      const fill = row.fill
      if (
        !fill ||
        row.account !== b.account ||
        row.conversation.source !== 'feishu-local' ||
        row.conversation.externalId !== dmKey(b).externalId
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
        await replyFeishu(
          b.app,
          b.account,
          row.deliveryId,
          b.chat,
          fill.prose || outcomeSentence(fill.outcome, 'Orca'),
          signal
        )
      }
      await journal.sent([{ account: b.account, deliveryId: row.deliveryId }])
    }
    if (rows.length < 32) {
      break
    }
  } while (!signal.aborted)
}
