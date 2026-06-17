import type {
  TrelloAttachment,
  TrelloBoard,
  TrelloCard,
  TrelloComment,
  TrelloLabel,
  TrelloList,
  TrelloMember
} from '../../shared/trello-types'

function toStringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function normalizeTrelloAvatarUrl(value: unknown): string | null {
  const url = toStringOrNull(value)
  if (!url) {
    return null
  }
  // Trello member avatarUrl is often an extensionless base URL; browsers need a concrete image.
  return /\.(?:png|jpe?g|gif|webp)(?:\?.*)?$/i.test(url) ? url : `${url}/50.png`
}

function toBool(value: unknown): boolean {
  return value === true
}

function toArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

export function mapTrelloBoard(data: Record<string, unknown>): TrelloBoard {
  return {
    id: toStringOrEmpty(data.id),
    name: toStringOrEmpty(data.name),
    url: toStringOrEmpty(data.url),
    shortUrl: toStringOrEmpty(data.shortUrl)
  }
}

export function mapTrelloList(data: Record<string, unknown>): TrelloList {
  return {
    id: toStringOrEmpty(data.id),
    name: toStringOrEmpty(data.name),
    idBoard: toStringOrEmpty(data.idBoard),
    pos: typeof data.pos === 'number' ? data.pos : 0,
    closed: toBool(data.closed)
  }
}

export function mapTrelloLabel(data: unknown): TrelloLabel {
  if (!data || typeof data !== 'object') {
    return { id: '', name: '', color: null }
  }
  const record = data as Record<string, unknown>
  return {
    id: toStringOrEmpty(record.id),
    name: toStringOrEmpty(record.name),
    color: toStringOrNull(record.color)
  }
}

export function mapTrelloMember(data: unknown): TrelloMember {
  if (!data || typeof data !== 'object') {
    return { id: '', username: '', fullName: '' }
  }
  const record = data as Record<string, unknown>
  return {
    id: toStringOrEmpty(record.id),
    username: toStringOrEmpty(record.username),
    fullName: toStringOrEmpty(record.fullName),
    avatarUrl: normalizeTrelloAvatarUrl(record.avatarUrl)
  }
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

export function mapTrelloAttachment(data: Record<string, unknown>): TrelloAttachment {
  return {
    id: toStringOrEmpty(data.id),
    name: toStringOrEmpty(data.name),
    fileName: toStringOrEmpty(data.fileName),
    mimeType: toStringOrEmpty(data.mimeType),
    url: toStringOrEmpty(data.url)
  }
}

export function mapTrelloCard(data: Record<string, unknown>): TrelloCard {
  const board = nestedRecord(data.board)
  const list = nestedRecord(data.list)
  return {
    id: toStringOrEmpty(data.id),
    shortId: String(data.idShort ?? ''),
    shortLink: toStringOrEmpty(data.shortLink),
    name: toStringOrEmpty(data.name),
    desc: toStringOrEmpty(data.desc),
    url: toStringOrEmpty(data.url),
    shortUrl: toStringOrEmpty(data.shortUrl),
    closed: toBool(data.closed),
    dueComplete: toBool(data.dueComplete),
    due: toStringOrNull(data.due),
    idBoard: toStringOrEmpty(data.idBoard),
    idList: toStringOrEmpty(data.idList),
    boardName: board ? toStringOrEmpty(board.name) : undefined,
    listName: list ? toStringOrEmpty(list.name) : undefined,
    labels: toArray<unknown>(data.labels).map(mapTrelloLabel),
    members: toArray<unknown>(data.members).map(mapTrelloMember),
    dateLastActivity: toStringOrEmpty(data.dateLastActivity)
  }
}

function getTrelloCommentText(
  actionData: Record<string, unknown> | null,
  data: Record<string, unknown>
): string {
  const textData = actionData ? nestedRecord(actionData.textData) : null
  const display = nestedRecord(data.display)
  const entities = display ? nestedRecord(display.entities) : null
  const comment = entities ? nestedRecord(entities.comment) : null
  return toStringOrEmpty(actionData?.text ?? textData?.text ?? comment?.text ?? data.text)
}

export function mapTrelloComment(data: Record<string, unknown>): TrelloComment {
  const actionData = nestedRecord(data.data)
  const memberCreator = nestedRecord(data.memberCreator)
  return {
    id: toStringOrEmpty(data.id),
    // Trello commentCard actions may store text under data.text or data.textData.text.
    text: getTrelloCommentText(actionData, data),
    date: toStringOrEmpty(data.date),
    dateLastEdited: toStringOrNull(data.dateLastEdited),
    memberCreator: memberCreator ? mapTrelloMember(memberCreator) : undefined
  }
}
