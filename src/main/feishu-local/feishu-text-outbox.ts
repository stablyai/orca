import type { Binding } from './feishu-binding'
import type { FeishuStore } from './feishu-store-ops'
import { feishuReplyMessage, replyFeishu } from './feishu-replies'

export async function drainFeishuTextOutbox(
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
      if (!(await inbox.mayPostReply(b.account, row.id, Date.now()))) {
        changed()
        continue
      }
      if (!active()) {
        return
      }
      const route = await inbox.messageRoute(b.account, row.mid)
      const messageId = await replyFeishu(
        b.app,
        b.account,
        row.mid,
        route?.chat ?? b.chat,
        feishuReplyMessage(row.text, botName),
        `reply:${row.id}`,
        signal
      )
      if (route) {
        await inbox.putRoute(b.account, messageId, route)
      }
      await inbox.replyPosted(b.account, row.id, messageId)
    }
    if (rows.length < 32) {
      return
    }
  }
}
