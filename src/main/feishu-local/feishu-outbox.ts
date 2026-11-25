import type { ConnectorReplyJournal } from '../connector-cloud/connector-reply-outbox'
import { outcomeSentence } from '../connector-cloud/connector-reply-outcome-sentence'
import type { JournalConnectorReplyRow } from '../../shared/agent-session/journal/journal-connector-reply'
import { dmKey, type Binding } from './feishu-binding'
import { FeishuReplyTargetGone } from './feishu-cli'
import { replyFeishu, finalFeishuMessage, uploadFeishuFile } from './feishu-replies'
import type { FeishuStore } from './feishu-store-ops'

class PostWindowClosed extends Error {}
class DeliveryPaused extends Error {}

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
  const post = async (mid: string, fill: NonNullable<JournalConnectorReplyRow['fill']>) => {
    const start = await inbox.postWindowStart(b.account, mid, Date.now())
    const requireSendWindow = () => {
      if (!active()) {
        throw new DeliveryPaused()
      }
      const now = Date.now()
      if (start === null || now < start || now - start >= 55 * 60_000) {
        throw new PostWindowClosed()
      }
    }
    requireSendWindow()
    await checkProfile()
    if (fill.outcome === 'answered' || fill.outcome === 'no_answer') {
      const artifact = await inbox.artifact(b.account, mid)
      if (artifact && !artifact.posted) {
        let key = artifact.key
        if (!key) {
          requireSendWindow()
          key = await uploadFeishuFile(b.app, artifact.name, artifact.bytes, signal)
          await inbox.uploaded(b.account, mid, key)
        }
        requireSendWindow()
        await replyFeishu(
          b.app,
          b.account,
          mid,
          chat,
          { type: 'file', content: { file_key: key } },
          'file',
          signal
        )
        await inbox.filePosted(b.account, mid)
      }
      if (artifact && fill.outcome === 'no_answer') {
        return
      }
    }
    requireSendWindow()
    await replyFeishu(
      b.app,
      b.account,
      mid,
      chat,
      finalFeishuMessage(fill.prose || outcomeSentence(fill.outcome, 'Orca', fill.toolsRan)),
      'final',
      signal
    )
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
      const fill = row.fill
      if (
        !fill ||
        row.account !== b.account ||
        row.conversation.source !== conversation.source ||
        row.conversation.externalId !== conversation.externalId
      ) {
        continue
      }
      if (fill.answerDeliveryId === row.deliveryId && fill.outcome !== 'quiet') {
        try {
          await post(row.deliveryId, fill)
        } catch (error) {
          if (error instanceof DeliveryPaused || !active()) {
            return
          }
          if (!(error instanceof PostWindowClosed || error instanceof FeishuReplyTargetGone)) {
            retry = true
            continue
          }
          // Leave the durable owner-review record before retiring the automatic delivery.
          if (await inbox.review(b.account, row.deliveryId)) {
            changed()
          }
        }
      }
      if (!active()) {
        return
      }
      await journal.sent([{ account: b.account, deliveryId: row.deliveryId }])
    }
    if (rows.length < 32) {
      break
    }
  } while (!signal.aborted)
  if (retry) {
    throw new Error('Some Feishu replies need another attempt')
  }
}
