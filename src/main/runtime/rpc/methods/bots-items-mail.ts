// What one write changed on a chat's items, when that chat didn't make it: owner and other-agent changes
// send one orchestration mail to that chat (or Home Chat when it takes no mail) and show a passive chat
// note; same-bot sibling-chat changes only show the passive chat note without waking the bot.
import type { Bot } from '../../../../shared/bot-types'
import { botItemEventId, type BotItemActor } from '../../../../shared/bots/bot-items'
import { BOT_ITEM_MAIL_ID_PREFIX } from '../../../../shared/bots/bot-item-note-runs'
import { BOT_ITEM_MAIL_SENDER } from '../../../../shared/bots/bot-item-mail-sender'
import { botMailSession, botMailSessionStillCurrent } from '../../../bots/bot-mail-chat'
import { ownerCommentAttachmentBody } from '../../../bots/bot-item-comment-attachment-body'
import { takeAdmittedCommentClaim } from '../../../bots/bot-item-comment-admitted-claims'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { isAgentSessionAttachmentExpiredError } from '../../../native-chat/agent-session-attachments/agent-session-attachment-claims'
import {
  getAgentSessionAttachmentClaimer,
  getAgentSessionAttachmentStore,
  type AgentSessionAttachmentClaimer
} from '../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import {
  agentSessionAttachmentClaimWithoutUploads,
  agentSessionAttachmentReferences
} from '../../../native-chat/agent-session-attachments/agent-session-attachment-references'
import type { BotItemNoteBy } from '../../../../shared/bots/bot-item-note'
import { appendBotItemNote, botItemNote } from '../../../bots/bot-item-chat-notes'
import {
  botItemChangeMail,
  botItemMailImages,
  botItemMailWithoutExpiredImages
} from '../../../bots/bot-items-mail-text'
import type { BotItemMail } from '../../../bots/bot-items-schema'
import type { OrcaRuntimeService } from '../../orca-runtime'

/** A message id from the first item event it carries. */
export function botItemMailId(eventId: number): string {
  return `${BOT_ITEM_MAIL_ID_PREFIX}${botItemEventId(eventId)}`
}

/** Who a mailed change's note names: the owner, the bot's chat that made it ('other-chat' once
 *  that chat is gone), or another agent. */
function noteBy(
  runtime: OrcaRuntimeService,
  bot: Bot,
  actor: BotItemActor | undefined
): BotItemNoteBy {
  if (actor?.kind === 'owner') {
    return 'owner'
  }
  if (actor?.kind !== 'bot') {
    return 'other-chat'
  }
  if (actor.botId !== bot.id) {
    return 'other-agent'
  }
  const items = runtime.botItems
  const source = items.chatSource(bot, actor.chatId, (id) => items.chatRootOf(id), null)
  const chat = items.owningChat({ chatId: actor.chatId, source })
  if (chat.gone) {
    return 'other-chat'
  }
  const home = chat.kind === 'home' ? { home: true as const } : {}
  return { kind: 'chat', chatId: chat.id, title: chat.title, ...home }
}

/** The chat whose conversation's turn asked the question the owner's comment in this write answers. */
function answerAskedIn(owed: BotItemMail): string | null {
  for (const { event } of owed.changes) {
    const asked = event.data.askedInConversation
    if (event.kind === 'commented' && event.actor.kind === 'owner' && typeof asked === 'string') {
      return asked
    }
  }
  return null
}

async function claimItemMailUploads(
  claim: AgentSessionAttachmentClaimer,
  root: string,
  sessionId: string,
  body: AgentJournalMessageItem,
  expired: Set<string>
): Promise<void> {
  let remaining = expired.size
    ? agentSessionAttachmentClaimWithoutUploads(root, body, expired)
    : body
  while (remaining.blocks.length > 0) {
    try {
      await claim(sessionId, remaining)
      return
    } catch (error) {
      if (!isAgentSessionAttachmentExpiredError(error)) {
        throw error
      }
      // Older mail can name files already lost. The other files still need the recipient's claim.
      const previous = expired.size
      for (const { uploadId } of error.expired) {
        expired.add(uploadId)
      }
      if (expired.size === previous) {
        throw error
      }
      remaining = agentSessionAttachmentClaimWithoutUploads(root, body, expired)
    }
  }
}

const notedSelfEchoes = new WeakMap<object, Set<number>>()

function isSameBotSelfEcho(botId: string, changes: BotItemMail['changes']): boolean {
  return (
    changes.length > 0 &&
    changes.every(({ event }) => event.actor.kind === 'bot' && event.actor.botId === botId)
  )
}

function leadActor(botId: string, changes: BotItemMail['changes']): BotItemActor | undefined {
  return (
    changes.find(({ event }) => event.actor.kind === 'owner')?.event.actor ??
    changes.find(({ event }) => event.actor.kind !== 'bot' || event.actor.botId !== botId)?.event
      .actor ??
    changes[0]?.event.actor
  )
}

/** Handles one owed item write: mails and wakes the chat unless every change is this bot's own sibling-chat echo, and appends the passive chat note. */
export async function sendBotItemMail(
  runtime: OrcaRuntimeService,
  owed: BotItemMail
): Promise<boolean> {
  const db = runtime.getOrchestrationDb()
  const id = botItemMailId(owed.id)
  if (db.getMessageById(id) || notedSelfEchoes.get(db)?.has(owed.id)) {
    return true
  }
  const mail = botItemChangeMail(owed.changes)
  const bot = runtime.bots.list().find((entry) => entry.id === owed.ownerBotId)
  // Changes with nothing to say, or a bot that's gone, owe nothing.
  if (!mail || !bot) {
    return true
  }
  const selfEcho = isSameBotSelfEcho(bot.id, owed.changes)
  let sessionId = await botMailSession(runtime, bot, owed.chatId)
  if (!selfEcho) {
    const expired = new Set<string>()
    const comment = owed.changes.find(
      ({ event }) => ownerCommentAttachmentBody(event) !== null
    )?.event
    const attachment = comment ? ownerCommentAttachmentBody(comment) : null
    if (comment && attachment) {
      const store = getAgentSessionAttachmentStore()
      const claim = getAgentSessionAttachmentClaimer()
      if (!store || !claim) {
        return false
      }
      const uploadIds = agentSessionAttachmentReferences(store.rootDir, attachment)
      if (uploadIds.size > 0) {
        // Never opens a store: a drain only runs on one already open.
        const items = runtime.botItems.openedStore()
        // The outbox keeps the uploads until the actual recipient claims them.
        for (let attempt = 0; ; attempt++) {
          if (
            attempt > 0 ||
            !items ||
            !takeAdmittedCommentClaim(items, comment.id, { sessionId, uploadIds })
          ) {
            await claimItemMailUploads(claim, store.rootDir, sessionId, attachment, expired)
          }
          if (botMailSessionStillCurrent(runtime, bot.id, owed.chatId, sessionId)) {
            break
          }
          const current = runtime.bots.list().find((entry) => entry.id === bot.id)
          if (!current) {
            return true
          }
          if (attempt === 1) {
            return false
          }
          sessionId = await botMailSession(runtime, current, owed.chatId)
        }
      }
    }
    const deliveredChanges = expired.size
      ? botItemMailWithoutExpiredImages(owed.changes, expired)
      : owed.changes
    const images = botItemMailImages(deliveredChanges)
    const delivered = expired.size ? (botItemChangeMail(deliveredChanges) ?? mail) : mail
    const asker = answerAskedIn(owed)
    const payload = JSON.stringify({
      botItems: owed.changes.map(({ event, item }) => ({
        uid: item.uid,
        number: item.number,
        eventId: botItemEventId(event.id),
        kind: event.kind
      })),
      // Delivered as the chat's image blocks, as chat sends a pasted image.
      ...(images.length > 0 ? { images } : {}),
      // The owner's answer to a question the item's chat asked while its thread's turn ran; the reader
      // checks it is that chat (conversation-ask-answer.ts).
      ...(asker ? { askedInConversation: asker } : {})
    })
    const to = `orca_session_id:${sessionId}`
    db.insertMessage({
      id,
      from: BOT_ITEM_MAIL_SENDER,
      to,
      type: 'status',
      subject: mail.subject,
      body: expired.size
        ? `${delivered.body}\n\n[Orca: Some of the owner's attachments expired before delivery.]`
        : delivered.body,
      payload,
      orcaAuthored: 'item-mail'
    })
    runtime.notifyMessageArrived(to, 'status')
  }
  // The chat shows the change itself, naming who made it; the mail row stays hidden there. A change
  // made in the chat the mail lands in (Home, when the item's chat takes no mail) has its own row there.
  const by = noteBy(runtime, bot, leadActor(bot.id, owed.changes))
  if (typeof by !== 'object' || by.chatId !== runtime.botItems.chatRootOf(sessionId)) {
    // A link is named against the item's links; unread, the chat line still shows, PRs as #n.
    const linked = owed.changes
      .filter(({ event }) => event.kind === 'linked')
      .map(({ item }) => item)
    const read =
      linked.length > 0
        ? await runtime.botItems.views(linked).catch((error: unknown) => {
            console.warn('[bots] items: reading links for a chat note failed', error)
            return []
          })
        : []
    const views = new Map(read.map((view) => [view.uid, view]))
    const changes = owed.changes.map((change) => ({
      ...change,
      links: views.get(change.item.uid)?.links
    }))
    const noted = await appendBotItemNote(sessionId, botItemNote(`m${owed.id}`, by, changes))
    if (!noted && selfEcho) {
      return false
    }
  }
  if (selfEcho) {
    let seen = notedSelfEchoes.get(db)
    if (!seen) {
      seen = new Set()
      notedSelfEchoes.set(db, seen)
    }
    seen.add(owed.id)
  }
  return true
}
