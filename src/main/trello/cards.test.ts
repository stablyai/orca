import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getCard,
  listBoardLabels,
  listBoardMembers,
  listCards,
  searchCards,
  updateCard,
  uploadCardAttachment
} from './cards'
import { trelloRequest } from './client'

vi.mock('./client', () => ({
  acquire: vi.fn(async () => undefined),
  release: vi.fn(),
  trelloRequest: vi.fn()
}))

const mockedTrelloRequest = vi.mocked(trelloRequest)

describe('Trello cards API', () => {
  beforeEach(() => {
    mockedTrelloRequest.mockReset()
  })

  it('maps board members and labels for inline card properties', async () => {
    mockedTrelloRequest
      .mockResolvedValueOnce([
        {
          id: 'm-1',
          username: 'ada',
          fullName: 'Ada Lovelace',
          avatarUrl: 'https://a.trello.test/avatar'
        }
      ])
      .mockResolvedValueOnce([{ id: 'l-1', name: 'Bug', color: 'red' }])

    await expect(listBoardMembers('board-1')).resolves.toEqual([
      {
        id: 'm-1',
        username: 'ada',
        fullName: 'Ada Lovelace',
        avatarUrl: 'https://a.trello.test/avatar/50.png'
      }
    ])
    await expect(listBoardLabels('board-1')).resolves.toEqual([
      { id: 'l-1', name: 'Bug', color: 'red' }
    ])

    expect(mockedTrelloRequest).toHaveBeenNthCalledWith(
      1,
      '/boards/board-1/members?fields=username,fullName,avatarUrl'
    )
    expect(mockedTrelloRequest).toHaveBeenNthCalledWith(
      2,
      '/boards/board-1/labels?fields=name,color'
    )
  })

  it('serializes member and label updates without leaking credentials', async () => {
    mockedTrelloRequest.mockResolvedValueOnce({
      id: 'card-1',
      name: 'Card',
      desc: '',
      idBoard: 'board-1',
      idList: 'list-1',
      labels: [],
      members: []
    })

    await updateCard('card-1', {
      idMembers: ['m-1', 'm-2'],
      idLabels: ['l-1']
    })

    expect(mockedTrelloRequest).toHaveBeenCalledWith('/cards/card-1', {
      method: 'PUT',
      body: JSON.stringify({ idMembers: 'm-1,m-2', idLabels: 'l-1' })
    })
  })

  it('uploads pasted data images as Trello card attachments', async () => {
    mockedTrelloRequest.mockResolvedValueOnce([
      {
        id: 'att-1',
        name: 'image.png',
        fileName: 'image.png',
        mimeType: 'image/png',
        url: 'https://trello.com/1/cards/card-1/attachments/att-1/download/image.png'
      }
    ])

    await expect(
      uploadCardAttachment({
        cardId: 'card-1',
        name: 'image.png',
        mimeType: 'image/png',
        contentBase64: 'AQID'
      })
    ).resolves.toEqual({
      id: 'att-1',
      name: 'image.png',
      fileName: 'image.png',
      mimeType: 'image/png',
      url: 'https://trello.com/1/cards/card-1/attachments/att-1/download/image.png'
    })

    expect(mockedTrelloRequest).toHaveBeenCalledWith('/cards/card-1/attachments', {
      method: 'POST',
      body: expect.any(FormData)
    })
  })
  it('maps Trello idShort into shared shortId', async () => {
    mockedTrelloRequest.mockResolvedValueOnce({
      id: 'card-1',
      name: 'My Card',
      desc: '',
      shortLink: 'abc123',
      shortUrl: 'https://trello.com/c/abc123',
      url: 'https://trello.com/c/abc123/my-card',
      closed: false,
      dueComplete: false,
      due: null,
      idBoard: 'board-1',
      idList: 'list-1',
      idShort: 42,
      labels: [],
      members: [],
      dateLastActivity: '2026-01-01'
    })

    const card = await getCard('card-1')
    expect(card).toEqual(expect.objectContaining({ shortId: '42' }))
  })

  it('preserves card-embedded members via mapTrelloCard', async () => {
    mockedTrelloRequest.mockResolvedValueOnce({
      id: 'card-1',
      name: 'My Card',
      desc: '',
      shortLink: 'abc123',
      shortUrl: 'https://trello.com/c/abc123',
      url: 'https://trello.com/c/abc123/my-card',
      closed: false,
      dueComplete: false,
      due: null,
      idBoard: 'board-1',
      idList: 'list-1',
      idShort: 7,
      labels: [],
      members: [
        {
          id: 'u-1',
          username: 'ada',
          fullName: 'Ada Lovelace',
          avatarUrl: 'https://a.trello.test/avatar'
        }
      ],
      dateLastActivity: '2026-01-01'
    })

    const card = await getCard('card-1')
    expect(card).toEqual(
      expect.objectContaining({
        members: [
          {
            id: 'u-1',
            username: 'ada',
            fullName: 'Ada Lovelace',
            avatarUrl: 'https://a.trello.test/avatar/50.png'
          }
        ]
      })
    )
  })

  it('throws when attachment upload returns an empty array', async () => {
    mockedTrelloRequest.mockResolvedValueOnce([])

    await expect(
      uploadCardAttachment({
        cardId: 'card-1',
        name: 'file.png',
        mimeType: 'image/png',
        contentBase64: 'AQID'
      })
    ).rejects.toThrow('Trello attachment upload returned no attachments')
  })

  it('listCards assigned requests expanded member data in URL', async () => {
    mockedTrelloRequest.mockResolvedValueOnce([])

    await listCards('assigned', 10)

    const url = mockedTrelloRequest.mock.calls[0][0] as string
    expect(url).toContain('members=true')
    expect(url).toContain('member_fields=username,fullName,avatarUrl')
    expect(url).toContain('fields=')
    expect(url).toContain('idMembers')
  })

  it('listCards allOpen requests expanded member data per board', async () => {
    mockedTrelloRequest.mockResolvedValueOnce([])

    await listCards('allOpen', 10, ['board-1'])

    const url = mockedTrelloRequest.mock.calls[0][0] as string
    expect(url).toContain('boards/board-1/cards')
    expect(url).toContain('members=true')
    expect(url).toContain('member_fields=username,fullName,avatarUrl')
  })

  it('getCard requests expanded member data in URL', async () => {
    mockedTrelloRequest.mockResolvedValueOnce({
      id: 'card-1',
      name: 'Card',
      desc: '',
      shortLink: 'abc',
      shortUrl: 'https://trello.com/c/abc',
      url: 'https://trello.com/c/abc/card',
      closed: false,
      dueComplete: false,
      due: null,
      idBoard: 'board-1',
      idList: 'list-1',
      idShort: 1,
      idMembers: [],
      labels: [],
      members: [],
      dateLastActivity: '2026-01-01'
    })

    await getCard('card-1')

    const url = mockedTrelloRequest.mock.calls[0][0] as string
    expect(url).toContain('members=true')
    expect(url).toContain('member_fields=username,fullName,avatarUrl')
  })

  it('searchCards hydrates members from board membership when search omits expanded members', async () => {
    mockedTrelloRequest
      .mockResolvedValueOnce({
        cards: [
          {
            id: 'card-1',
            name: 'Card',
            desc: '',
            shortLink: 'abc',
            shortUrl: 'https://trello.com/c/abc',
            url: 'https://trello.com/c/abc/card',
            closed: false,
            dueComplete: false,
            due: null,
            idBoard: 'board-1',
            idList: 'list-1',
            idShort: 1,
            idMembers: ['m-1'],
            labels: [],
            members: [],
            dateLastActivity: '2026-01-01'
          }
        ]
      })
      .mockResolvedValueOnce([
        {
          id: 'm-1',
          username: 'ada',
          fullName: 'Ada Lovelace',
          avatarUrl: 'https://a.trello.test/avatar'
        }
      ])

    const cards = await searchCards('test', 10)

    expect(cards[0]?.members).toEqual([
      {
        id: 'm-1',
        username: 'ada',
        fullName: 'Ada Lovelace',
        avatarUrl: 'https://a.trello.test/avatar/50.png'
      }
    ])
    expect(mockedTrelloRequest.mock.calls[0][0]).not.toContain('cards_member_fields')
    expect(mockedTrelloRequest.mock.calls[1][0]).toBe(
      '/boards/board-1/members?fields=username,fullName,avatarUrl'
    )
  })

  it('listCards allOpen sorts across boards by dateLastActivity descending', async () => {
    const olderCard = {
      id: 'card-old',
      name: 'Old Card',
      desc: '',
      shortLink: 'old',
      shortUrl: 'https://trello.com/c/old',
      url: 'https://trello.com/c/old/old-card',
      closed: false,
      dueComplete: false,
      due: null,
      idBoard: 'board-1',
      idList: 'list-1',
      idShort: 1,
      labels: [],
      members: [],
      dateLastActivity: '2026-01-01'
    }
    const newerCard = {
      ...olderCard,
      id: 'card-new',
      name: 'New Card',
      shortLink: 'new',
      shortUrl: 'https://trello.com/c/new',
      url: 'https://trello.com/c/new/new-card',
      idBoard: 'board-2',
      dateLastActivity: '2026-06-01'
    }

    mockedTrelloRequest.mockResolvedValueOnce([olderCard]).mockResolvedValueOnce([newerCard])

    const cards = await listCards('allOpen', 2, ['board-1', 'board-2'])

    expect(cards).toHaveLength(2)
    expect(cards[0].id).toBe('card-new')
    expect(cards[1].id).toBe('card-old')
  })
})
