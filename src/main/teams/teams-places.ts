// What every `orca teams` verb shares: a place read from a ref or link, the scope check, a chat's
// label, and Graph lists read a bounded number of pages.
import type { TeamsPlaceView } from '../../shared/teams/teams-connect-types'
import type { z } from 'zod'
import { GraphChat, GraphNamed } from './teams-graph-shapes'
import type { TeamsGraph } from './teams-graph'
import { formatTeamsRef, parseTeamsPlace, type TeamsPlace } from './teams-place-ref'
import { hasTeamsScope, type TeamsScope } from './teams-scopes'

const NOT_A_PLACE =
  'Pass a ref from `orca teams find` (teams:chat/… or teams:channel/…) or a link copied from Teams.'

export const missingScope = (scope: TeamsScope) =>
  `Your Teams sign-in doesn't include ${scope}. Your owner runs \`orca teams connect\` again without --chats-only; ChannelMessage.Read.All needs an admin to approve it for the app.`

/** The signed-in person's id, once their sign-in has `scope`. */
export async function requireScope(graph: TeamsGraph, scope: TeamsScope): Promise<string> {
  const { userId, grantedScopes } = await graph.account()
  if (!hasTeamsScope(grantedScopes, scope)) {
    throw new Error(missingScope(scope))
  }
  return userId
}

export function placeOf(input: string): TeamsPlace {
  const place = parseTeamsPlace(input)
  if (!place) {
    throw new Error(NOT_A_PLACE)
  }
  return place
}

export const id = (value: string) => encodeURIComponent(value)
export const chatPath = (chatId: string) => `/chats/${id(chatId)}`
export const channelPath = (place: { teamId: string; channelId: string }) =>
  `/teams/${id(place.teamId)}/channels/${id(place.channelId)}`

export function chatLabel(chat: GraphChat, userId: string): string {
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

/** Up to `pages` pages of a list; `partial` when Graph had more past them. */
export async function pagesOf<T>(
  graph: TeamsGraph,
  first: string,
  shape: z.ZodType<{ value?: T[]; '@odata.nextLink'?: string }>,
  pages: number
): Promise<{ items: T[]; partial: boolean }> {
  const items: T[] = []
  let next: string | undefined = first
  for (let page = 0; next && page < pages; page++) {
    const answer = await graph.get(next, shape)
    items.push(...(answer.value ?? []))
    next = answer['@odata.nextLink']
  }
  return { items, partial: next !== undefined }
}

/** A chat or channel's label from Graph, for a place named by ref or link. */
export async function describe(graph: TeamsGraph, place: TeamsPlace): Promise<TeamsPlaceView> {
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
