import type { Binding } from './feishu-binding'
import type { FeishuStore } from './feishu-store-ops'
import { dmKey } from './feishu-binding'
import type { FeishuCardDelivery } from './feishu-card-delivery'

export async function drainFeishuTextOutbox(
  inbox: FeishuStore,
  b: Binding,
  active: () => boolean,
  checkProfile: () => Promise<void>,
  changed: () => void,
  cards: FeishuCardDelivery
): Promise<void> {
  if (!b.chat) {
    return
  }
  while (active()) {
    const rows = await inbox.pendingReplies(b.account)
    for (const row of rows) {
      if (!active()) {
        return
      }
      await checkProfile()
      if (!active()) {
        return
      }
      const route = await inbox.messageRoute(b.account, row.mid)
      const id = await inbox.updateResponse(
        b.account,
        route?.external ?? dmKey(b).externalId,
        row.mid,
        route?.chat ?? b.chat,
        {
          kind: 'progress',
          id: row.id,
          text: row.text
        }
      )
      const messageId = id && (await cards.publish(id))
      if (!messageId) {
        changed()
        return
      }
      await inbox.replyPosted(b.account, row.id, messageId)
    }
    if (rows.length < 32) {
      return
    }
  }
}
