import type { ConnectorReplyJournal } from '../connector-cloud/connector-reply-outbox'
import { outcomeSentence } from '../connector-cloud/connector-reply-outcome-sentence'
import type { JournalConnectorReplyRow } from '../../shared/agent-session/journal/journal-connector-reply'
import { dmKey, type Binding } from './feishu-binding'
import { FeishuReplyTargetGone } from './feishu-cli'
import { replyFeishu, finalFeishuMessage, uploadFeishuFile } from './feishu-replies'
import type { FeishuStore } from './feishu-store-ops'

class PostWindowClosed extends Error {}
class DeliveryPaused extends Error {}
type Reply = NonNullable<JournalConnectorReplyRow['fill']>

/** Only the delivery named by the native turn's stamps owns the answer. */
export async function drainFeishuOutbox(
  journal: Pick<ConnectorReplyJournal, 'readOwed' | 'sent'>,
  inbox: FeishuStore,
  b: Binding,
  signal: AbortSignal,
  active: () => boolean,
  checkProfile: () => Promise<void>,
  changed: () => void
): Promise<void> {
  const chat = b.chat
  if (!chat) {
    return
  }
  const conversation = dmKey(b)
  const post = async (mid: string, fill: Reply, firstPost: number | null) => {
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
      await replyFeishu(b.app, b.account, mid, chat, message, part, signal)
    }
    const artifact =
      fill.outcome === 'answered' || fill.outcome === 'no_answer'
        ? await inbox.artifact(b.account, mid)
        : undefined
    if (artifact?.posted && fill.outcome === 'no_answer') {
      return
    }
    requireSendWindow()
    await checkProfile()
    if (artifact) {
      if (!artifact.posted) {
        let key = artifact.key
        if (!key) {
          requireSendWindow()
          key = await uploadFeishuFile(b.app, artifact.name, artifact.bytes, signal)
          await inbox.uploaded(b.account, mid, key)
        }
        await reply({ type: 'file', content: { file_key: key } }, 'file')
        await inbox.filePosted(b.account, mid)
      }
      if (fill.outcome === 'no_answer') {
        return
      }
    }
    await reply(
      finalFeishuMessage(fill.prose || outcomeSentence(fill.outcome, 'Orca', fill.toolsRan)),
      'final'
    )
  }
  const settle = async (mid: string, fill: Reply) => {
    const state = await inbox.replyState(b.account, mid)
    if (state && !state.done) {
      let review = state.review
      if (!review && fill.answerDeliveryId === mid && fill.outcome !== 'quiet') {
        try {
          await post(mid, fill, state.firstPost)
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
  do {
    const rows = await journal.readOwed(b.account, after, 32)
    for (const row of rows) {
      after = row.deliveryId
      if (!active()) {
        return
      }
      if (
        !row.fill ||
        row.account !== b.account ||
        row.conversation.source !== conversation.source ||
        row.conversation.externalId !== conversation.externalId
      ) {
        continue
      }
      try {
        await settle(row.deliveryId, row.fill)
      } catch (error) {
        if (error instanceof DeliveryPaused || !active()) {
          return
        }
        retry = true
      }
    }
    if (rows.length < 32) {
      break
    }
  } while (!signal.aborted)
  if (retry) {
    throw new Error('Some Feishu replies need another attempt')
  }
}
