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
  GraphChat,
  GraphMessage,
  GraphNamed,
  MessagePage,
  NamedPage,
  type GraphChannel,
  type GraphTeam
} from './teams-graph-shapes'
import type { TeamsGraph } from './teams-graph'
import { teamsMessageText, teamsPostHtml } from './teams-message-text'
import { formatTeamsRef, parseTeamsPlace, type TeamsPlace } from './teams-place-ref'
import { hasTeamsScope, type TeamsScope } from './teams-scopes'

const CHAT_PAGES = 4
const TEAMS_SCANNED = 50
const CHANNEL_LOOKUPS_AT_ONCE = 5
const DEFAULT_LIMIT = 20

const NOT_A_PLACE =
  'Pass a ref from `orca teams find` (teams:chat/… or teams:channel/…) or a link copied from Teams.'

const missingScope = (scope: TeamsScope) =>
  `Your Teams sign-in doesn't include ${scope}. Your owner runs \`orca teams connect\` again without --chats-only; ChannelMessage.Read.All needs an admin to approve it for the app.`

async function requireScope(graph: TeamsGraph, scope: TeamsScope): Promise<void> {
  const { grantedScopes } = await graph.account()
  if (!hasTeamsScope(grantedScopes, scope)) {
    throw new Error(missingScope(scope))
  }
}

function placeOf(input: string): TeamsPlace {
  const place = parseTeamsPlace(input)
  if (!place) {
    throw new Error(NOT_A_PLACE)
  }
  return place
}

const id = (value: string) => encodeURIComponent(value)
const chatPath = (chatId: string) => `/chats/${id(chatId)}`
const channelPath = (place: { teamId: string; channelId: string }) =>
  `/teams/${id(place.teamId)}/channels/${id(place.channelId)}`

function chatLabel(chat: GraphChat, userId: string): string {
  const others = (chat.members ?? [])
    .filter((member) => member.userId !== userId)
    .map((member) => member.displayName?.trim())
    .filter((name): name is string => Boolean(name))
  if (chat.topic?.trim()) {
    return chat.topic.trim()
  }
  if (chat.chatType === 'oneOnOne' && others.length === 1) {
    return `Chat with ${others[0]}`
  }
  return others.length > 0 ? `Chat with ${others.join(', ')}` : 'Chat'
}

/** Best first: the whole label, then a label that starts with it, then one that has it. */
function rank(label: string, query: string): number {
  const l = label.toLowerCase()
  return l === query ? 0 : l.startsWith(query) ? 1 : 2
}

async function allChats(graph: TeamsGraph): Promise<GraphChat[]> {
  const chats: GraphChat[] = []
  let next: string | undefined = '/me/chats?$expand=members&$top=50'
  for (let page = 0; next && page < CHAT_PAGES; page++) {
    const answer = await graph.get(next, ChatPage)
    chats.push(...(answer.value ?? []))
    next = answer['@odata.nextLink']
  }
  return chats
}

async function allChannels(
  graph: TeamsGraph
): Promise<{ team: GraphTeam; channel: GraphChannel }[]> {
  const teams = (await graph.get('/me/joinedTeams?$select=id,displayName', NamedPage)).value
  const scanned = (teams ?? []).slice(0, TEAMS_SCANNED)
  const found: { team: GraphTeam; channel: GraphChannel }[] = []
  for (let start = 0; start < scanned.length; start += CHANNEL_LOOKUPS_AT_ONCE) {
    const batch = scanned.slice(start, start + CHANNEL_LOOKUPS_AT_ONCE)
    const lists = await Promise.all(
      batch.map((team) =>
        graph
          .get(`/teams/${id(team.id)}/channels?$select=id,displayName`, NamedPage)
          .then((answer) => (answer.value ?? []).map((channel) => ({ team, channel })))
      )
    )
    found.push(...lists.flat())
  }
  return found
}

/** A chat or channel's label from Graph, for a place named by ref or link. */
async function describe(graph: TeamsGraph, place: TeamsPlace): Promise<TeamsPlaceView> {
  if (place.kind === 'chat') {
    const [chat, { userId }] = await Promise.all([
      graph.get(`${chatPath(place.chatId)}?$expand=members`, GraphChat),
      graph.account()
    ])
    return {
      ref: formatTeamsRef({ kind: 'chat', chatId: place.chatId }),
      label: chatLabel(chat, userId),
      kind: 'chat'
    }
  }
  const [team, channel] = await Promise.all([
    graph.get(`/teams/${id(place.teamId)}?$select=id,displayName`, GraphNamed),
    graph.get(`${channelPath(place)}?$select=id,displayName`, GraphNamed)
  ])
  const label = `${team.displayName ?? 'Team'} › ${channel.displayName ?? 'Channel'}`
  return place.messageId
    ? { ref: formatTeamsRef(place), label: `Thread in ${label}`, kind: 'thread' }
    : { ref: formatTeamsRef(place), label, kind: 'channel' }
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
  const [chats, channels] = await Promise.all([
    only === 'channels' ? [] : allChats(graph),
    only === 'chats' || !canChannels ? [] : allChannels(graph)
  ])
  const matches: TeamsPlaceView[] = [
    ...chats.flatMap((chat) => {
      const names = [chat.topic ?? '', ...(chat.members ?? []).map((m) => m.displayName ?? '')]
      return names.some((name) => name.toLowerCase().includes(words))
        ? [
            {
              ref: formatTeamsRef({ kind: 'chat', chatId: chat.id }),
              label: chatLabel(chat, userId),
              kind: 'chat' as const
            }
          ]
        : []
    }),
    ...channels.flatMap(({ team, channel }) => {
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
  const note =
    only === 'channels' && !canChannels
      ? missingScope('Channel.ReadBasic.All')
      : !canChannels && only === null
        ? 'Only chats were searched: this sign-in has no channel permissions.'
        : undefined
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

/** Messages people wrote, oldest first: system events and deleted messages are left out. */
function shown(place: TeamsPlace, messages: GraphMessage[]): TeamsMessageView[] {
  return messages
    .filter((message) => message.messageType === 'message' && !message.deletedDateTime)
    .sort((a, b) => (a.createdDateTime ?? '').localeCompare(b.createdDateTime ?? ''))
    .map((message) => messageView(place, message))
}

/** A chat or channel's latest messages, or a thread's root and its latest replies, oldest first. */
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
    const page = await graph.get(
      `${chatPath(place.chatId)}/messages?$top=${limit}&$orderby=createdDateTime desc`,
      MessagePage
    )
    return {
      place: view,
      messages: shown(chat, page.value ?? []),
      more: Boolean(page['@odata.nextLink'])
    }
  }
  if (!place.messageId) {
    const page = await graph.get(`${channelPath(place)}/messages?$top=${limit}`, MessagePage)
    return {
      place: view,
      messages: shown(place, page.value ?? []),
      more: Boolean(page['@odata.nextLink'])
    }
  }
  const thread = `${channelPath(place)}/messages/${id(place.messageId)}`
  const [root, replies] = await Promise.all([
    graph.get(thread, GraphMessage),
    graph.get(`${thread}/replies?$top=${limit}`, MessagePage)
  ])
  return {
    place: view,
    messages: shown(place, [root, ...(replies.value ?? [])]),
    more: Boolean(replies['@odata.nextLink'])
  }
}

/** Posts in a chat or channel, or replies in a channel thread (any message ref in it), as the signed-in person. */
export async function postTeamsMessage(
  graph: TeamsGraph,
  ref: string,
  text: string
): Promise<TeamsPostView> {
  const place = placeOf(ref)
  await requireScope(graph, place.kind === 'chat' ? 'ChatMessage.Send' : 'ChannelMessage.Send')
  const body = { body: { contentType: 'html', content: teamsPostHtml(text) } }
  const path =
    place.kind === 'chat'
      ? `${chatPath(place.chatId)}/messages`
      : place.messageId
        ? `${channelPath(place)}/messages/${id(place.messageId)}/replies`
        : `${channelPath(place)}/messages`
  const posted = await graph.post(path, body, GraphMessage)
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
  await requireScope(graph, place.kind === 'chat' ? 'ChatMessage.Send' : 'ChannelMessage.Send')
  const message =
    place.kind === 'chat'
      ? `${chatPath(place.chatId)}/messages/${id(place.messageId)}`
      : `${channelPath(place)}/messages/${id(place.messageId)}${place.replyId ? `/replies/${id(place.replyId)}` : ''}`
  await graph.post(`${message}/setReaction`, { reactionType: emoji }, z.unknown())
  return { ref: formatTeamsRef(place), reaction: emoji }
}
