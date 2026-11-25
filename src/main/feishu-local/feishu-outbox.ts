import type { ConnectorReplyJournal } from '../connector-cloud/connector-reply-outbox'
import { outcomeSentence } from '../connector-cloud/connector-reply-outcome-sentence'
import type { JournalConnectorReplyRow } from '../../shared/agent-session/journal/journal-connector-reply'
import { splitImText } from '../im-stream/im-stream-chunks'
import { dmKey, type Binding } from './feishu-binding'
import { FEISHU_ANSWER_BYTES, feishuFinalCard, feishuJoinedCard } from './feishu-card'
import { FeishuApiError, FeishuPermissionDenied, FeishuReplyTargetGone } from './feishu-cli'
import {
  replyFeishu,
  finalFeishuMessage,
  uploadFeishuFile,
  type FeishuReply
} from './feishu-replies'
import type { FeishuStore } from './feishu-store-ops'
import type { FeishuStream } from './feishu-stream'

class PostWindowClosed extends Error {}
class DeliveryPaused extends Error {}
type Reply = NonNullable<JournalConnectorReplyRow['fill']>
type Row = Pick<JournalConnectorReplyRow, 'sessionId' | 'messageId'>
export type FeishuReplyCards = Pick<FeishuStream, 'cardOf' | 'finish' | 'patch' | 'process'>

// The card can't take this edit, ever: not a card, too long, malformed, or past its edit window.
const CARD_REFUSED = new Set([230001, 230025, 230031, 230099])

function cardRefused(error: unknown): boolean {
  return (
    error instanceof FeishuPermissionDenied ||
    error instanceof FeishuReplyTargetGone ||
    (error instanceof FeishuApiError && CARD_REFUSED.has(error.code))
  )
}

function alsoAnswers(text: string, also: readonly string[]): string {
  return also.length > 0
    ? `${text}\n\n— Also answers: ${also.map((each) => `“${each}”`).join(' · ')}`
    : text
}

/** Only the delivery named by the native turn's stamps owns the answer. */
export async function drainFeishuOutbox(
  journal: Pick<ConnectorReplyJournal, 'readOwed' | 'sent'>,
  inbox: FeishuStore,
  b: Binding,
  signal: AbortSignal,
  active: () => boolean,
  checkProfile: () => Promise<void>,
  changed: () => void,
  cards: FeishuReplyCards
): Promise<void> {
  const chat = b.chat
  if (!chat) {
    return
  }
  const conversation = dmKey(b)
  const post = async (mid: string, row: Row, fill: Reply, firstPost: number | null) => {
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
    const openWindow = async () => {
      requireSendWindow()
      if (start === null) {
        start = await inbox.postWindowStart(b.account, mid, Date.now())
        if (start === null) {
          throw new PostWindowClosed()
        }
      }
      requireSendWindow()
    }
    const reply = async (message: FeishuReply, part: string) => {
      await openWindow()
      await replyFeishu(b.app, b.account, mid, chat, message, part, signal)
    }
    // The streamed card shows the answer's first part, folding the process; false once it can't.
    // An edit repeats safely, so it needs no uuid window.
    const finalCard = async (answer: string, also: readonly string[]): Promise<boolean> => {
      const card = await cards.cardOf(mid)
      if (!card) {
        return false
      }
      await cards.finish(mid)
      const process = await cards.process(row.sessionId, row.messageId)
      if (!active()) {
        throw new DeliveryPaused()
      }
      try {
        await cards.patch(card, JSON.stringify(feishuFinalCard(answer, process, also)))
      } catch (error) {
        if (!cardRefused(error)) {
          throw error
        }
        await inbox.abandonCard(b.account, mid)
        return false
      }
      await inbox.cardFinal(b.account, mid)
      return true
    }
    const artifact =
      fill.outcome === 'answered' || fill.outcome === 'no_answer'
        ? await inbox.artifact(b.account, mid)
        : undefined
    if (artifact?.posted && fill.outcome === 'no_answer') {
      await finalCard('', []).catch(() => false)
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
        await finalCard('', []).catch(() => false)
        return
      }
    }
    const text = fill.prose || outcomeSentence(fill.outcome, 'Orca', fill.toolsRan)
    const also = await inbox.mergedExcerpts(b.account, mid)
    const [first = '', ...rest] = splitImText(text, FEISHU_ANSWER_BYTES)
    // A card that took its final words owes only the parts after them.
    const carded =
      (await inbox.card(b.account, mid))?.progress === 3 || (await finalCard(first, also))
    const parts = carded ? rest : splitImText(alsoAnswers(text, also), FEISHU_ANSWER_BYTES)
    for (const [index, part] of parts.entries()) {
      const at = carded ? index + 1 : index
      await reply(finalFeishuMessage(part), at === 0 ? 'final' : `cont-${at}`)
    }
  }
  // A reply that doesn't own the answer: its card says which one does; a quiet turn's card ends.
  const closeCard = async (mid: string, row: Row, fill: Reply) => {
    const shown = await inbox.card(b.account, mid)
    if (!shown?.card || shown.progress >= 3) {
      return
    }
    await cards.finish(mid)
    const head =
      fill.answerDeliveryId !== mid ? await inbox.card(b.account, fill.answerDeliveryId) : null
    const content =
      fill.answerDeliveryId !== mid
        ? feishuJoinedCard(head?.excerpt ?? null)
        : feishuFinalCard('', await cards.process(row.sessionId, row.messageId), [])
    await cards.patch(shown.card, JSON.stringify(content)).catch(() => {})
    await inbox.cardFinal(b.account, mid)
  }
  const settle = async (mid: string, row: Row, fill: Reply) => {
    const state = await inbox.replyState(b.account, mid)
    if (state && !state.done) {
      let review = state.review
      if (!review && (fill.answerDeliveryId !== mid || fill.outcome === 'quiet')) {
        await closeCard(mid, row, fill)
      } else if (!review) {
        try {
          await post(mid, row, fill, state.firstPost)
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
    // Before any head posts, so its reply names the follow-ups it answers.
    for (const row of rows) {
      if (row.fill && row.fill.answerDeliveryId !== row.deliveryId && row.account === b.account) {
        await inbox.merged(b.account, [row.deliveryId], row.fill.answerDeliveryId)
      }
    }
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
        await settle(row.deliveryId, row, row.fill)
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
