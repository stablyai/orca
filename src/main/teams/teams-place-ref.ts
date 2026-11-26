// Where a Teams verb acts, as a ref Orca prints (teams:chat/…, teams:channel/…) or a link copied from
// Teams. Ids are checked to their known shapes before any reaches a Graph URL.
export type TeamsPlace =
  | { kind: 'chat'; chatId: string; messageId?: string }
  /** messageId names a thread: the post its replies hang under; replyId one reply in it. */
  | { kind: 'channel'; teamId: string; channelId: string; messageId?: string; replyId?: string }

const THREAD_ID = /^19:[\w.@=-]+$/
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MESSAGE_ID = /^\d{1,20}$/
const TEAMS_HOSTS = new Set(['teams.microsoft.com', 'teams.cloud.microsoft'])

export function formatTeamsRef(place: TeamsPlace): string {
  const reply =
    place.kind === 'channel' && place.messageId && place.replyId ? `/${place.replyId}` : ''
  const tail = place.messageId ? `/${place.messageId}${reply}` : ''
  return place.kind === 'chat'
    ? `teams:chat/${place.chatId}${tail}`
    : `teams:channel/${place.teamId}/${place.channelId}${tail}`
}

function chat(chatId: string, messageId?: string): TeamsPlace | null {
  if (!THREAD_ID.test(chatId) || (messageId !== undefined && !MESSAGE_ID.test(messageId))) {
    return null
  }
  return messageId ? { kind: 'chat', chatId, messageId } : { kind: 'chat', chatId }
}

function channel(
  teamId: string,
  channelId: string,
  messageId?: string,
  replyId?: string
): TeamsPlace | null {
  if (
    !GUID.test(teamId) ||
    !THREAD_ID.test(channelId) ||
    (messageId !== undefined && !MESSAGE_ID.test(messageId)) ||
    (replyId !== undefined && (messageId === undefined || !MESSAGE_ID.test(replyId)))
  ) {
    return null
  }
  const base = { kind: 'channel' as const, teamId: teamId.toLowerCase(), channelId }
  if (!messageId) {
    return base
  }
  return replyId && replyId !== messageId ? { ...base, messageId, replyId } : { ...base, messageId }
}

function parseRef(input: string): TeamsPlace | null {
  const [kind, ...parts] = input.slice('teams:'.length).split('/')
  if (kind === 'chat' && (parts.length === 1 || parts.length === 2)) {
    return chat(parts[0] ?? '', parts[1])
  }
  if (kind === 'channel' && parts.length >= 2 && parts.length <= 4) {
    return channel(parts[0] ?? '', parts[1] ?? '', parts[2], parts[3])
  }
  return null
}

function segment(value: string | undefined): string {
  try {
    return decodeURIComponent(value ?? '')
  } catch {
    return ''
  }
}

/** Links Teams' "Copy link" gives for a channel, a chat, or a message in either. */
function parseLink(input: string): TeamsPlace | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || !TEAMS_HOSTS.has(url.hostname)) {
    return null
  }
  const [, l, kind, rawId, rawMessage] = url.pathname.split('/')
  if (l !== 'l') {
    return null
  }
  const id = segment(rawId)
  const teamId = url.searchParams.get('groupId')
  if (kind === 'channel') {
    return teamId ? channel(teamId, id) : null
  }
  if (kind === 'chat') {
    return chat(id)
  }
  if (kind !== 'message') {
    return null
  }
  const messageId = segment(rawMessage)
  if (!teamId) {
    return chat(id, messageId)
  }
  // A reply's link carries its thread's root, where a post to it goes.
  const parent = url.searchParams.get('parentMessageId')
  return parent && parent !== '0' && parent !== messageId
    ? channel(teamId, id, parent, messageId)
    : channel(teamId, id, messageId)
}

/** A ref or a Teams link; null for anything else (a name is for `orca teams find`). */
export function parseTeamsPlace(input: string): TeamsPlace | null {
  const trimmed = input.trim()
  return trimmed.startsWith('teams:') ? parseRef(trimmed) : parseLink(trimmed)
}
