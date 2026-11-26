import type { ConnectorReplyJournal } from '../connector-cloud/connector-reply-outbox'
import { outcomeSentence } from '../connector-cloud/connector-reply-outcome-sentence'
import type { JournalConnectorReplyRow } from '../../shared/agent-session/journal/journal-connector-reply'
import { dmKey, groupKey, type Binding } from './feishu-binding'
import type { FeishuGroupRoute } from './feishu-message'
import type { FeishuTransport } from './feishu-transport'
import { FeishuReplyTargetGone, FeishuUploadPermissionError } from './feishu-transport'
import { replyFeishu, finalFeishuMessage } from './feishu-replies'
import type { FeishuStore } from './feishu-store-ops'

class PostWindowClosed extends Error {}
class DeliveryPaused extends Error {}
type Reply = NonNullable<JournalConnectorReplyRow['fill']>

/** Only the delivery named by the native turn's stamps owns the answer. */
export async function drainFeishuOutbox(
  api: Pick<FeishuTransport, 'reply' | 'upload'>,
  journal: Pick<ConnectorReplyJournal, 'readOwed' | 'sent'>,
  inbox: FeishuStore,
  b: Binding,
  signal: AbortSignal,
  active: () => boolean,
  changed: () => void
): Promise<void> {
  if (!b.chat) {
    return
  }
  const conversation = dmKey(b)
  const post = async (
    mid: string,
    fill: Reply,
    firstPost: number | null,
    chat: string,
    group?: FeishuGroupRoute
  ) => {
    let start = firstPost
    const requireSendWindow = () => {
      if (!active()) {
        throw new DeliveryPaused()
      }
      const now = Date.now()
      if (start !== null && (now < start || now - start >= 55 * 60_000)) {
        throw new PostWindowClosed()
      }
    }
    const reply = async (message: Parameters<typeof replyFeishu>[4], part: 'file' | 'final') => {
      requireSendWindow()
      if (start === null) {
        start = await inbox.postWindowStart(b.account, mid, Date.now())
        if (start === null) {
          throw new PostWindowClosed()
        }
      }
      requireSendWindow()
      await replyFeishu(api, b.account, mid, chat, message, part, group)
    }
    const artifact =
      !group && (fill.outcome === 'answered' || fill.outcome === 'no_answer')
        ? await inbox.artifact(b.account, mid)
        : undefined
    if (artifact?.posted && fill.outcome === 'no_answer') {
      return
    }
    requireSendWindow()
    if (artifact) {
      if (!artifact.posted) {
        let key = artifact.key
        if (!key) {
          requireSendWindow()
          if (!artifact.bytes) {
            throw new Error('File content is unavailable')
          }
          key = await api.upload(artifact.name, artifact.bytes)
          await inbox.uploaded(b.account, mid, key)
        }
        await reply({ type: 'file', content: { file_key: key } }, 'file')
        await inbox.filePosted(b.account, mid)
      }
      if (fill.outcome === 'no_answer') {
        return
      }
    }
    const text = fill.prose || outcomeSentence(fill.outcome, 'Orca', fill.toolsRan)
    await reply(group ? { type: 'text', content: { text } } : finalFeishuMessage(text), 'final')
  }
  const settle = async (mid: string, fill: Reply, chat: string, group?: FeishuGroupRoute) => {
    const state = await inbox.replyState(b.account, mid)
    if (state && !state.done) {
      let review = state.review
      if (!review && fill.answerDeliveryId === mid && fill.outcome !== 'quiet') {
        try {
          await post(mid, fill, state.firstPost, chat, group)
        } catch (error) {
          if (!(error instanceof PostWindowClosed || error instanceof FeishuReplyTargetGone)) {
            throw error
          }
          review = true
        }
      }
      if (await inbox.finishReply(b.account, mid, review)) {
        changed()
      }
    }
    await journal.sent([{ account: b.account, deliveryId: mid }])
  }
  let after: string | null = null
  let retry = false
  let uploadDenied = false
  do {
    const rows = await journal.readOwed(b.account, after, 32)
    for (const row of rows) {
      after = row.deliveryId
      if (!active()) {
        return
      }
      const { deliveryId, fill } = row
      if (!fill || row.account !== b.account) {
        continue
      }
      try {
        if (
          row.conversation.source !== 'feishu-local' &&
          row.conversation.source !== 'feishu-group'
        ) {
          continue
        }
        const group = await inbox.groupRoute(b.account, deliveryId)
        if (
          !group &&
          row.conversation.source === conversation.source &&
          row.conversation.externalId === conversation.externalId
        ) {
          await settle(deliveryId, fill, b.chat)
        } else if (
          row.conversation.source === 'feishu-group' &&
          b.profile === null &&
          b.group &&
          group?.chatId === b.group.chatId &&
          b.group.members.includes(group.sender) &&
          groupKey(b, group).externalId === row.conversation.externalId
        ) {
          await settle(deliveryId, fill, group.chatId, group)
        }
      } catch (error) {
        if (error instanceof DeliveryPaused || !active()) {
          return
        }
        uploadDenied ||= error instanceof FeishuUploadPermissionError
        retry = true
      }
    }
    if (rows.length < 32) {
      break
    }
  } while (!signal.aborted)
  if (uploadDenied) {
    throw new FeishuUploadPermissionError()
  }
  if (retry) {
    throw new Error('Some Feishu replies need another attempt')
  }
}
