// `orca teams find|read|post|react` on this host, through Microsoft Graph as the signed-in person.
import type {
  TeamsFindView,
  TeamsMessageView,
  TeamsPlaceView,
  TeamsPostView,
  TeamsReadView
} from '../../shared/teams/teams-connect-types'
import { z } from 'zod'
import {
  ChatPage,
  GraphMessage,
  MessagePage,
  NamedPage,
  type GraphChannel,
  type GraphTeam
} from './teams-graph-shapes'
import type { TeamsGraph } from './teams-graph'
import { teamsMessageText, teamsPostHtml } from './teams-message-text'
import { formatTeamsRef, parseTeamsPlace, type TeamsPlace } from './teams-place-ref'
import {
  channelPath,
  chatLabel,
  chatPath,
  describe,
  id,
  missingScope,
  pagesOf,
  placeOf,
  requireScope
} from './teams-places'
import { hasTeamsScope } from './teams-scopes'

const CHAT_PAGES = 4
const CHANNEL_PAGES = 3
const READ_PAGES = 3
// Graph lists at most this many of a chat's members when they are expanded.
const EXPANDED_MEMBERS = 25
const TEAMS_SCANNED = 50
const CHANNEL_LOOKUPS_AT_ONCE = 5
const DEFAULT_LIMIT = 20

/** Best first: the whole label, then a label that starts with it, then one that has it. */
function rank(label: string, query: string): number {
  const l = label.toLowerCase()
  return l === query ? 0 : l.startsWith(query) ? 1 : 2
}

async function allChannels(
  graph: TeamsGraph
): Promise<{ found: { team: GraphTeam; channel: GraphChannel }[]; partial: boolean }> {
  const teams = (await graph.get('/me/joinedTeams?$select=id,displayName', NamedPage)).value ?? []
  const scanned = teams.slice(0, TEAMS_SCANNED)
  const found: { team: GraphTeam; channel: GraphChannel }[] = []
  let partial = teams.length > scanned.length
  for (let start = 0; start < scanned.length; start += CHANNEL_LOOKUPS_AT_ONCE) {
    const batch = scanned.slice(start, start + CHANNEL_LOOKUPS_AT_ONCE)
    const lists = await Promise.all(
      batch.map(async (team) => {
        const channels = await pagesOf(
          graph,
          `/teams/${id(team.id)}/channels?$select=id,displayName`,
          NamedPage,
          CHANNEL_PAGES
        )
        partial ||= channels.partial
        return channels.items.map((channel) => ({ team, channel }))
      })
    )
    found.push(...lists.flat())
  }
  return { found, partial }
}

/**
 * Chats by topic or member name, and channels by team and channel name. `@name` looks only at chats,
 * `#name` only at channels; a ref or link is read back with its label.
 */
export async function findTeamsPlaces(
  graph: TeamsGraph,
  query: string,
  limit = DEFAULT_LIMIT
): Promise<TeamsFindView> {
  if (parseTeamsPlace(query)) {
    return { matches: [await describe(graph, placeOf(query))] }
  }
  const only = query.startsWith('@') ? 'chats' : query.startsWith('#') ? 'channels' : null
  const words = query.replace(/^[@#]/, '').trim().toLowerCase()
  if (!words) {
    throw new Error('Name a chat, person, team or channel to find.')
  }
  const { userId, grantedScopes } = await graph.account()
  const canChannels = hasTeamsScope(grantedScopes, 'Channel.ReadBasic.All')
  const none = { items: [], found: [], partial: false }
  const [chatList, channelList] = await Promise.all([
    only === 'channels'
      ? none
      : pagesOf(graph, '/me/chats?$expand=members&$top=50', ChatPage, CHAT_PAGES),
    only === 'chats' || !canChannels ? none : allChannels(graph)
  ])
  let chatsPartial = chatList.partial
  const matches: TeamsPlaceView[] = [
    ...chatList.items.flatMap((chat) => {
      const names = [chat.topic ?? '', ...(chat.members ?? []).map((m) => m.displayName ?? '')]
      const hit = names.some((name) => name.toLowerCase().includes(words))
      // A big group chat's other members aren't listed, so a miss there isn't certain.
      chatsPartial ||= !hit && (chat.members?.length ?? 0) >= EXPANDED_MEMBERS
      return hit
        ? [
            {
              ref: formatTeamsRef({ kind: 'chat', chatId: chat.id }),
              label: chatLabel(chat, userId),
              kind: 'chat' as const
            }
          ]
        : []
    }),
    ...channelList.found.flatMap(({ team, channel }) => {
      const label = `${team.displayName ?? 'Team'} › ${channel.displayName ?? 'Channel'}`
      return label.toLowerCase().includes(words) ||
        `${team.displayName} ${channel.displayName}`.toLowerCase().includes(words)
        ? [
            {
              ref: formatTeamsRef({ kind: 'channel', teamId: team.id, channelId: channel.id }),
              label,
              kind: 'channel' as const
            }
          ]
        : []
    })
  ]
    .map((match, order) => ({
      match,
      order,
      rank: rank(match.label.replace(/^Chat with /, ''), words)
    }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, limit)
    .map(({ match }) => match)
  const note = [
    only === 'channels' && !canChannels
      ? missingScope('Channel.ReadBasic.All')
      : !canChannels && only === null
        ? 'Only chats were searched: this sign-in has no channel permissions.'
        : '',
    chatsPartial
      ? `Some chats weren't fully searched (over ${CHAT_PAGES * 50} chats, or group chats with more than ${EXPANDED_MEMBERS} people, whose other members Graph doesn't list); search by the chat's topic, or pass a link to it.`
      : '',
    channelList.partial
      ? `Some channels weren't searched (over ${TEAMS_SCANNED} teams, or a team with over ${CHANNEL_PAGES} pages of channels); pass a link to the channel.`
      : ''
  ]
    .filter(Boolean)
    .join(' ')
  return { matches, ...(note ? { note } : {}) }
}

function messageView(place: TeamsPlace, message: GraphMessage): TeamsMessageView {
  const from =
    message.from?.user?.displayName ?? message.from?.application?.displayName ?? 'Someone'
  // In a thread a reply's ref keeps the root: a post to it answers in the thread.
  const at: TeamsPlace =
    place.kind === 'channel' && place.messageId
      ? { ...place, ...(message.id === place.messageId ? {} : { replyId: message.id }) }
      : { ...place, messageId: message.id }
  return {
    ref: formatTeamsRef(at),
    from,
    at: message.createdDateTime ?? '',
    text: teamsMessageText(message.body, message.attachments ?? [])
  }
}

const wrote = (message: GraphMessage) =>
  message.messageType === 'message' && !message.deletedDateTime

/** Reads on until `limit` messages people wrote are in hand, so system events never fill the window. */
async function messagesWritten(
  graph: TeamsGraph,
  first: string,
  limit: number
): Promise<{ messages: GraphMessage[]; more: boolean }> {
  const kept: GraphMessage[] = []
  let next: string | undefined = first
  for (let page = 0; next && kept.length < limit && page < READ_PAGES; page++) {
    const answer = await graph.get(next, MessagePage)
    kept.push(...(answer.value ?? []).filter(wrote))
    next = answer['@odata.nextLink']
  }
  return { messages: kept.slice(0, limit), more: next !== undefined || kept.length > limit }
}

/** Messages people wrote, oldest first: system events and deleted messages are left out. */
function shown(place: TeamsPlace, messages: GraphMessage[]): TeamsMessageView[] {
  return messages
    .filter(wrote)
    .sort((a, b) => (a.createdDateTime ?? '').localeCompare(b.createdDateTime ?? ''))
    .map((message) => messageView(place, message))
}

/**
 * A chat's latest messages, a channel's threads with the latest activity (Graph's order), or a
 * thread's root and its latest replies; each shown oldest first.
 */
export async function readTeamsPlace(
  graph: TeamsGraph,
  ref: string,
  limit = DEFAULT_LIMIT
): Promise<TeamsReadView> {
  const named = placeOf(ref)
  // A reply's ref reads its whole thread.
  const place: TeamsPlace =
    named.kind === 'channel' && named.replyId
      ? {
          kind: 'channel',
          teamId: named.teamId,
          channelId: named.channelId,
          messageId: named.messageId
        }
      : named
  await requireScope(graph, place.kind === 'chat' ? 'Chat.Read' : 'ChannelMessage.Read.All')
  const view = await describe(graph, place)
  if (place.kind === 'chat') {
    const chat = { kind: 'chat' as const, chatId: place.chatId }
    const read = await messagesWritten(
      graph,
      `${chatPath(place.chatId)}/messages?$top=${limit}&$orderby=createdDateTime desc`,
      limit
    )
    return { place: view, messages: shown(chat, read.messages), more: read.more }
  }
  if (!place.messageId) {
    const read = await messagesWritten(graph, `${channelPath(place)}/messages?$top=${limit}`, limit)
    return { place: view, messages: shown(place, read.messages), more: read.more }
  }
  const thread = `${channelPath(place)}/messages/${id(place.messageId)}`
  const [root, replies] = await Promise.all([
    graph.get(thread, GraphMessage),
    messagesWritten(graph, `${thread}/replies?$top=${limit}`, limit)
  ])
  return { place: view, messages: shown(place, [root, ...replies.messages]), more: replies.more }
}

/** Posts in a chat or channel, or replies in a channel thread (any message ref in it), as the signed-in person. */
export async function postTeamsMessage(
  graph: TeamsGraph,
  ref: string,
  text: string
): Promise<TeamsPostView> {
  const place = placeOf(ref)
  const asUser = await requireScope(
    graph,
    place.kind === 'chat' ? 'ChatMessage.Send' : 'ChannelMessage.Send'
  )
  const body = { body: { contentType: 'html', content: teamsPostHtml(text) } }
  const path =
    place.kind === 'chat'
      ? `${chatPath(place.chatId)}/messages`
      : place.messageId
        ? `${channelPath(place)}/messages/${id(place.messageId)}/replies`
        : `${channelPath(place)}/messages`
  const posted = await graph.post(path, body, GraphMessage, asUser)
  const at: TeamsPlace =
    place.kind === 'chat'
      ? { kind: 'chat', chatId: place.chatId, messageId: posted.id }
      : place.messageId
        ? { ...place, replyId: posted.id }
        : { ...place, messageId: posted.id }
  return { ref: formatTeamsRef(at), ...(posted.webUrl ? { webUrl: posted.webUrl } : {}) }
}

/** Adds the signed-in person's reaction, an emoji, to one message or reply. */
export async function reactToTeamsMessage(
  graph: TeamsGraph,
  ref: string,
  emoji: string
): Promise<{ ref: string; reaction: string }> {
  const place = placeOf(ref)
  if (!place.messageId) {
    throw new Error('Pass a message ref from `orca teams read`, not a chat or channel.')
  }
  const asUser = await requireScope(
    graph,
    place.kind === 'chat' ? 'ChatMessage.Send' : 'ChannelMessage.Send'
  )
  const message =
    place.kind === 'chat'
      ? `${chatPath(place.chatId)}/messages/${id(place.messageId)}`
      : `${channelPath(place)}/messages/${id(place.messageId)}${place.replyId ? `/replies/${id(place.replyId)}` : ''}`
  await graph.post(`${message}/setReaction`, { reactionType: emoji }, z.unknown(), asUser)
  return { ref: formatTeamsRef(place), reaction: emoji }
}
