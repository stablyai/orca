// The Graph reads behind the Teams mention check, each within a page budget. What a budget leaves
// unread comes back to resume: the chat list's next page, or the part of a chat's window still unread.
import type { TeamsGraph } from './teams-graph'
import { ChatPage, MessagePage, type GraphChat, type GraphMessage } from './teams-graph-shapes'
import { formatTeamsRef } from './teams-place-ref'

const CHAT_PAGES = 4
const MESSAGE_PAGES = 3

export const CHATS_BY_LAST_MESSAGE =
  '/me/chats?$expand=lastMessagePreview&$orderby=lastMessagePreview/createdDateTime desc&$top=50'

/** Messages modified after `from` and, when set, before `until` (ms). */
export type ChatWindow = { from: number; until?: number }

export const at = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : Number.NaN)
const isoOf = (ms: number) => new Date(ms).toISOString()

/**
 * Chats with a message since `from`, newest first, from `first` (the list, or a next page saved
 * earlier); only `only` when every rule names its chats. `next`: the page the budget stopped at.
 */
export async function changedChats(
  graph: TeamsGraph,
  first: string,
  from: number,
  only: Set<string> | null
): Promise<{ chats: GraphChat[]; next?: string }> {
  const chats: GraphChat[] = []
  let next: string | undefined = first
  for (let pages = 0; next && pages < CHAT_PAGES; pages++) {
    const page = await graph.get(next, ChatPage)
    const listed = page.value ?? []
    const fresh = listed.filter((chat) => at(chat.lastMessagePreview?.createdDateTime) >= from)
    chats.push(
      ...fresh.filter(
        (chat) => !only || only.has(formatTeamsRef({ kind: 'chat', chatId: chat.id }))
      )
    )
    // Newest first, so a page that ends on an older chat is the last one needed.
    next = fresh.length === listed.length ? page['@odata.nextLink'] : undefined
  }
  return { chats, ...(next ? { next } : {}) }
}

/**
 * A chat's messages in `window`, newest change first (the only order Graph has). `rest`: the older
 * part of the window the budget left unread, for the next check.
 */
export async function messagesIn(
  graph: TeamsGraph,
  chatId: string,
  window: ChatWindow
): Promise<{ messages: GraphMessage[]; rest?: Required<ChatWindow> }> {
  const range = [
    `lastModifiedDateTime gt ${isoOf(window.from)}`,
    ...(window.until === undefined ? [] : [`lastModifiedDateTime lt ${isoOf(window.until)}`])
  ].join(' and ')
  const messages: GraphMessage[] = []
  let next: string | undefined =
    `/chats/${encodeURIComponent(chatId)}/messages?$top=50&$orderby=lastModifiedDateTime desc&$filter=${range}`
  for (let pages = 0; next && pages < MESSAGE_PAGES; pages++) {
    const page = await graph.get(next, MessagePage)
    messages.push(...(page.value ?? []))
    next = page['@odata.nextLink']
  }
  const oldest = Math.min(
    ...messages.map((message) => at(message.lastModifiedDateTime)).filter(Number.isFinite)
  )
  if (!next || !Number.isFinite(oldest)) {
    return { messages }
  }
  // The next check reads from the oldest change seen; one read twice is dropped by its ref. When a
  // whole budget shares that change time, it reads before it, so the window always shrinks.
  const until = oldest + 1 < (window.until ?? Number.POSITIVE_INFINITY) ? oldest + 1 : oldest
  return { messages, rest: { from: window.from, until } }
}

/** A new message from someone else that @mentions the signed-in person; edits of older ones never count. */
export function mentionOf(message: GraphMessage, userId: string, from: number): number | null {
  const created = at(message.createdDateTime)
  const mentioned = (message.mentions ?? []).some((entry) => entry.mentioned?.user?.id === userId)
  return message.messageType === 'message' &&
    !message.deletedDateTime &&
    message.from?.user?.id !== userId &&
    created >= from &&
    mentioned
    ? created
    : null
}
