// Item notes in chats: the quiet line a bot chat shows for item changes. The bot's own write shows in
// the chat that made it; a change the item's chat didn't make shows where its mail lands. Display only.
import {
  botItemNoteEntry,
  type AgentJournalBotItemNoteItem,
  type BotItemNoteBy
} from '../../shared/bots/bot-item-note'
import type { BotItemLinkView } from '../../shared/bots/bot-items'
import { appendOrcaChatCard } from '../runtime/orca-chat-card'
import type { BotItemsRemote } from './bot-items-ops'
import type { BotItemEventRecord, BotItemRecord } from './bot-items-schema'

/** `links`: the item's links as the wire shows them, which name a write's new links. */
type Change = {
  event: BotItemEventRecord
  item: BotItemRecord
  links?: readonly BotItemLinkView[]
}

export function botItemNote(
  noteId: string,
  by: BotItemNoteBy,
  changes: readonly Change[],
  closedChat?: AgentJournalBotItemNoteItem['closedChat']
): AgentJournalBotItemNoteItem | null {
  const entries = changes.flatMap(
    ({ event, item, links }) => botItemNoteEntry(event, item, links) ?? []
  )
  return entries.length > 0
    ? { kind: 'bot-item-note', noteId, by, entries, ...(closedChat ? { closedChat } : {}) }
    : null
}

/** Draws a note in `sessionId`'s chat, when this host runs it. */
export function appendBotItemNote(
  sessionId: string,
  note: AgentJournalBotItemNoteItem | null
): void {
  if (note) {
    appendOrcaChatCard(sessionId, note, 'showing an item change in its chat')
  }
}

/** The events one write made on one item: those up to `lastId` sharing its time and author. */
export function eventsOfOneWrite(
  events: readonly BotItemEventRecord[],
  lastId: number
): BotItemEventRecord[] {
  const last = events.find((event) => event.id === lastId)
  if (!last) {
    return []
  }
  const author = JSON.stringify(last.actor)
  return events.filter(
    (event) =>
      event.id <= lastId &&
      event.createdAt === last.createdAt &&
      JSON.stringify(event.actor) === author
  )
}

/** Shows one bot write in the chat that made it; `links` names its new links. */
export async function noteBotItemWrite(
  store: Pick<BotItemsRemote, 'events'>,
  sessionId: string,
  item: BotItemRecord,
  eventId: number,
  links: readonly BotItemLinkView[] | undefined
): Promise<void> {
  const recent = await store.events(item.uid, Math.max(0, eventId - 8), 16)
  const changes = eventsOfOneWrite(recent, eventId).map((event) => ({ event, item, links }))
  appendBotItemNote(sessionId, botItemNote(`w${eventId}`, 'bot', changes))
}
