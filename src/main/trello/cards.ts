import { trelloRequest, acquire, release } from './client'
import type {
  TrelloAttachment,
  TrelloBoard,
  TrelloCard,
  TrelloCardFilter,
  TrelloCardUpdate,
  TrelloComment,
  TrelloCreateCardArgs,
  TrelloUploadAttachmentArgs,
  TrelloLabel,
  TrelloList,
  TrelloMember
} from '../../shared/trello-types'
import {
  mapTrelloAttachment,
  mapTrelloBoard,
  mapTrelloCard,
  mapTrelloComment,
  mapTrelloLabel,
  mapTrelloList,
  mapTrelloMember
} from './mappers'

export async function listBoards(): Promise<TrelloBoard[]> {
  await acquire()
  try {
    const data = await trelloRequest<Record<string, unknown>[]>(
      '/members/me/boards?fields=name,url,shortUrl'
    )
    return data.map(mapTrelloBoard)
  } finally {
    release()
  }
}

export async function listLists(boardId: string): Promise<TrelloList[]> {
  await acquire()
  try {
    const data = await trelloRequest<Record<string, unknown>[]>(
      `/boards/${boardId}/lists?fields=name,idBoard,pos,closed`
    )
    return data.map(mapTrelloList)
  } finally {
    release()
  }
}

export async function listBoardMembers(boardId: string): Promise<TrelloMember[]> {
  await acquire()
  try {
    const data = await trelloRequest<Record<string, unknown>[]>(
      `/boards/${boardId}/members?fields=username,fullName,avatarUrl`
    )
    return data.map(mapTrelloMember)
  } finally {
    release()
  }
}

export async function listBoardLabels(boardId: string): Promise<TrelloLabel[]> {
  await acquire()
  try {
    const data = await trelloRequest<Record<string, unknown>[]>(
      `/boards/${boardId}/labels?fields=name,color`
    )
    return data.map(mapTrelloLabel)
  } finally {
    release()
  }
}

const CARD_MEMBER_FIELDS = 'username,fullName,avatarUrl'
const CARD_FIELDS =
  'name,desc,url,shortUrl,shortLink,closed,dueComplete,due,idBoard,idList,idMembers,labels,dateLastActivity,idShort'
const CARD_CONTEXT_FIELDS = `fields=${CARD_FIELDS}&board=true&board_fields=name,url,shortUrl&list=true&list_fields=name&members=true&member_fields=${CARD_MEMBER_FIELDS}`
function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function cardRequiresMemberHydration(card: Record<string, unknown>): boolean {
  const memberIds = stringArray(card.idMembers)
  const members = Array.isArray(card.members) ? card.members : []
  return memberIds.length > members.length && typeof card.idBoard === 'string'
}

async function mapCardsWithHydratedMembers(
  rawCards: Record<string, unknown>[]
): Promise<TrelloCard[]> {
  const boardIds = new Set<string>()
  for (const card of rawCards) {
    if (cardRequiresMemberHydration(card)) {
      boardIds.add(card.idBoard as string)
    }
  }
  if (boardIds.size === 0) {
    return rawCards.map(mapTrelloCard)
  }

  const membersByBoard = new Map<string, Map<string, TrelloMember>>()
  for (const boardId of boardIds) {
    const data = await trelloRequest<Record<string, unknown>[]>(
      `/boards/${boardId}/members?fields=${CARD_MEMBER_FIELDS}`
    )
    membersByBoard.set(
      boardId,
      new Map(data.map(mapTrelloMember).map((member) => [member.id, member]))
    )
  }

  return rawCards.map((card) => {
    if (!cardRequiresMemberHydration(card)) {
      return mapTrelloCard(card)
    }
    const members = membersByBoard.get(card.idBoard as string)
    if (!members) {
      return mapTrelloCard(card)
    }
    return mapTrelloCard({
      ...card,
      members: stringArray(card.idMembers)
        .map((memberId) => members.get(memberId))
        .filter((member): member is TrelloMember => Boolean(member))
    })
  })
}

export async function listCards(
  filter: TrelloCardFilter = 'assigned',
  limit = 30,
  boardIds?: string[]
): Promise<TrelloCard[]> {
  await acquire()
  try {
    if (filter === 'assigned') {
      const data = await trelloRequest<Record<string, unknown>[]>(
        `/members/me/cards?filter=open&${CARD_CONTEXT_FIELDS}&limit=${limit}`
      )
      return mapCardsWithHydratedMembers(data)
    }

    // For allOpen and archived, we need to query by board
    if (!boardIds || boardIds.length === 0) {
      return []
    }

    const trelloFilter = filter === 'archived' ? 'closed' : 'open'
    const allRawCards: Record<string, unknown>[] = []
    for (const boardId of boardIds) {
      const data = await trelloRequest<Record<string, unknown>[]>(
        `/boards/${boardId}/cards?filter=${trelloFilter}&${CARD_CONTEXT_FIELDS}&limit=${limit}`
      )
      allRawCards.push(...data)
    }
    const allCards = await mapCardsWithHydratedMembers(allRawCards)
    allCards.sort((a, b) => (b.dateLastActivity || '').localeCompare(a.dateLastActivity || ''))
    return allCards.slice(0, limit)
  } finally {
    release()
  }
}

export async function searchCards(
  query: string,
  limit = 30,
  boardIds?: string[]
): Promise<TrelloCard[]> {
  await acquire()
  try {
    let path = `/search?query=${encodeURIComponent(query)}&modelTypes=cards&cards_limit=${limit}&card_fields=${CARD_FIELDS}&cards_board=true&cards_list=true`
    if (boardIds && boardIds.length > 0) {
      path += `&idBoards=${boardIds.join(',')}`
    }
    const data = await trelloRequest<{ cards?: Record<string, unknown>[] }>(path)
    return mapCardsWithHydratedMembers(data.cards ?? [])
  } finally {
    release()
  }
}

export async function getCard(cardId: string): Promise<TrelloCard | null> {
  await acquire()
  try {
    const data = await trelloRequest<Record<string, unknown>>(
      `/cards/${cardId}?${CARD_CONTEXT_FIELDS}`
    )
    const cards = await mapCardsWithHydratedMembers([data])
    return cards[0] ?? null
  } finally {
    release()
  }
}

export async function createCard(args: TrelloCreateCardArgs): Promise<TrelloCard> {
  await acquire()
  try {
    const body: Record<string, unknown> = {
      idBoard: args.idBoard,
      idList: args.idList,
      name: args.name
    }
    if (args.desc) {
      body.desc = args.desc
    }
    const data = await trelloRequest<Record<string, unknown>>('/cards', {
      method: 'POST',
      body: JSON.stringify(body)
    })
    return mapTrelloCard(data)
  } finally {
    release()
  }
}

export async function uploadCardAttachment(
  args: TrelloUploadAttachmentArgs
): Promise<TrelloAttachment> {
  await acquire()
  try {
    const form = new FormData()
    const bytes = Buffer.from(args.contentBase64, 'base64')
    const content = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    form.set('file', new Blob([content], { type: args.mimeType }), args.name)
    form.set('name', args.name)
    form.set('mimeType', args.mimeType)
    const data = await trelloRequest<Record<string, unknown>[]>(
      `/cards/${encodeURIComponent(args.cardId)}/attachments`,
      {
        method: 'POST',
        body: form
      }
    )
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('Trello attachment upload returned no attachments')
    }
    return mapTrelloAttachment(data[0])
  } finally {
    release()
  }
}

export async function updateCard(
  cardId: string,
  updates: TrelloCardUpdate
): Promise<TrelloCard | null> {
  await acquire()
  try {
    const body: Record<string, unknown> = {}
    if (updates.name !== undefined) {
      body.name = updates.name
    }
    if (updates.desc !== undefined) {
      body.desc = updates.desc
    }
    if (updates.idList !== undefined) {
      body.idList = updates.idList
    }
    if (updates.closed !== undefined) {
      body.closed = updates.closed
    }
    if (updates.idMembers !== undefined) {
      body.idMembers = updates.idMembers.join(',')
    }
    if (updates.idLabels !== undefined) {
      body.idLabels = updates.idLabels.join(',')
    }
    const data = await trelloRequest<Record<string, unknown>>(`/cards/${cardId}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    })
    return mapTrelloCard(data)
  } finally {
    release()
  }
}

export async function addCardComment(cardId: string, text: string): Promise<TrelloComment> {
  await acquire()
  try {
    const data = await trelloRequest<Record<string, unknown>>(`/cards/${cardId}/actions/comments`, {
      method: 'POST',
      body: JSON.stringify({ text })
    })
    return mapTrelloComment(data)
  } finally {
    release()
  }
}

export async function cardComments(cardId: string): Promise<TrelloComment[]> {
  await acquire()
  try {
    const data = await trelloRequest<Record<string, unknown>[]>(
      `/cards/${cardId}/actions?filter=commentCard`
    )
    return data.map(mapTrelloComment)
  } finally {
    release()
  }
}
