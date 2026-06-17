import { ipcMain } from 'electron'
import { connect, disconnect, getStatus, testConnection, trelloDownload } from '../trello/client'
import {
  listBoards,
  listLists,
  listBoardLabels,
  listBoardMembers,
  listCards,
  searchCards,
  getCard,
  createCard,
  updateCard,
  addCardComment,
  cardComments,
  uploadCardAttachment
} from '../trello/cards'
import type {
  TrelloCardFilter,
  TrelloCardUpdate,
  TrelloConnectArgs,
  TrelloCreateCardArgs,
  TrelloUploadAttachmentArgs
} from '../../shared/trello-types'

const VALID_FILTERS = new Set<TrelloCardFilter>(['assigned', 'allOpen', 'archived'])

function clampLimit(value: unknown, fallback = 30): number {
  const limit = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(Math.max(1, limit), 100)
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined
}
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/
function isValidBase64(value: string): boolean {
  return value.length % 4 !== 1 && BASE64_PATTERN.test(value)
}

function normalizeCardUpdate(value: unknown): TrelloCardUpdate | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const input = value as TrelloCardUpdate
  if (input.name !== undefined && typeof input.name !== 'string') {
    return null
  }
  if (input.desc !== undefined && typeof input.desc !== 'string') {
    return null
  }
  if (input.idList !== undefined && input.idList !== null && typeof input.idList !== 'string') {
    return null
  }
  if (input.closed !== undefined && typeof input.closed !== 'boolean') {
    return null
  }
  if (input.idMembers !== undefined && !Array.isArray(input.idMembers)) {
    return null
  }
  if (input.idMembers?.some((id) => typeof id !== 'string')) {
    return null
  }
  if (input.idLabels !== undefined && !Array.isArray(input.idLabels)) {
    return null
  }
  if (input.idLabels?.some((id) => typeof id !== 'string')) {
    return null
  }
  return input
}

export function registerTrelloHandlers(): void {
  ipcMain.handle('trello:connect', async (_event, args: TrelloConnectArgs) => {
    if (typeof args?.apiKey !== 'string' || typeof args?.token !== 'string') {
      return { ok: false, error: 'API key and token are required.' }
    }
    return connect({
      apiKey: args.apiKey,
      token: args.token
    })
  })

  ipcMain.handle('trello:disconnect', async () => {
    disconnect()
  })

  ipcMain.handle('trello:status', async () => {
    return getStatus()
  })

  ipcMain.handle('trello:testConnection', async () => {
    return testConnection()
  })

  ipcMain.handle('trello:listBoards', async () => {
    return listBoards()
  })

  ipcMain.handle('trello:listLists', async (_event, args: { boardId: string }) => {
    if (typeof args?.boardId !== 'string' || !args.boardId.trim()) {
      return []
    }
    return listLists(args.boardId.trim())
  })

  ipcMain.handle('trello:listBoardMembers', async (_event, args: { boardId: string }) => {
    if (typeof args?.boardId !== 'string' || !args.boardId.trim()) {
      return []
    }
    return listBoardMembers(args.boardId.trim())
  })

  ipcMain.handle('trello:listBoardLabels', async (_event, args: { boardId: string }) => {
    if (typeof args?.boardId !== 'string' || !args.boardId.trim()) {
      return []
    }
    return listBoardLabels(args.boardId.trim())
  })

  ipcMain.handle(
    'trello:listCards',
    async (_event, args?: { filter?: TrelloCardFilter; limit?: number; boardIds?: string[] }) => {
      const filter = VALID_FILTERS.has(args?.filter as TrelloCardFilter)
        ? (args!.filter as TrelloCardFilter)
        : undefined
      const boardIds = normalizeStringArray(args?.boardIds)
      return listCards(filter, clampLimit(args?.limit), boardIds)
    }
  )

  ipcMain.handle(
    'trello:searchCards',
    async (_event, args: { query: string; limit?: number; boardIds?: string[] }) => {
      if (typeof args?.query !== 'string') {
        return []
      }
      const boardIds = normalizeStringArray(args.boardIds)
      return searchCards(args.query.trim(), clampLimit(args.limit), boardIds)
    }
  )

  ipcMain.handle('trello:getCard', async (_event, args: { cardId: string }) => {
    if (typeof args?.cardId !== 'string' || !args.cardId.trim()) {
      return null
    }
    return getCard(args.cardId.trim())
  })

  ipcMain.handle('trello:createCard', async (_event, args: TrelloCreateCardArgs) => {
    if (typeof args?.idBoard !== 'string' || !args.idBoard.trim()) {
      return { ok: false, error: 'Board is required.' }
    }
    if (typeof args?.idList !== 'string' || !args.idList.trim()) {
      return { ok: false, error: 'List is required.' }
    }
    if (typeof args?.name !== 'string' || !args.name.trim()) {
      return { ok: false, error: 'Title is required.' }
    }
    try {
      const card = await createCard({
        idBoard: args.idBoard.trim(),
        idList: args.idList.trim(),
        name: args.name.trim(),
        desc: args.desc?.trim() || undefined
      })
      return { ok: true as const, id: card.id, shortLink: card.shortLink, url: card.url }
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : 'Create failed.'
      }
    }
  })

  ipcMain.handle(
    'trello:updateCard',
    async (_event, args: { cardId: string; updates: TrelloCardUpdate }) => {
      if (typeof args?.cardId !== 'string' || !args.cardId.trim()) {
        return { ok: false, error: 'Card ID is required.' }
      }
      const updates = normalizeCardUpdate(args.updates)
      if (!updates) {
        return { ok: false, error: 'Updates object is required.' }
      }
      try {
        await updateCard(args.cardId.trim(), updates)
        return { ok: true as const }
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : 'Update failed.'
        }
      }
    }
  )

  ipcMain.handle(
    'trello:addCardComment',
    async (_event, args: { cardId: string; text: string }) => {
      if (typeof args?.cardId !== 'string' || !args.cardId.trim()) {
        return { ok: false, error: 'Card ID is required.' }
      }
      if (typeof args?.text !== 'string' || !args.text.trim()) {
        return { ok: false, error: 'Comment text is required.' }
      }
      try {
        const comment = await addCardComment(args.cardId.trim(), args.text.trim())
        return { ok: true as const, id: comment.id }
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : 'Comment failed.'
        }
      }
    }
  )

  ipcMain.handle('trello:cardComments', async (_event, args: { cardId: string }) => {
    if (typeof args?.cardId !== 'string' || !args.cardId.trim()) {
      return []
    }
    return cardComments(args.cardId.trim())
  })

  ipcMain.handle('trello:uploadAttachment', async (_event, args: TrelloUploadAttachmentArgs) => {
    if (typeof args?.cardId !== 'string' || !args.cardId.trim()) {
      return { ok: false as const, error: 'Card ID is required.' }
    }
    if (typeof args?.name !== 'string' || !args.name.trim()) {
      return { ok: false as const, error: 'Attachment name is required.' }
    }
    if (typeof args?.mimeType !== 'string' || !args.mimeType.startsWith('image/')) {
      return { ok: false as const, error: 'Only image attachments are supported.' }
    }
    if (typeof args?.contentBase64 !== 'string' || !args.contentBase64.trim()) {
      return { ok: false as const, error: 'Attachment content is required.' }
    }
    if (!isValidBase64(args.contentBase64)) {
      return { ok: false as const, error: 'Attachment content is not valid base64.' }
    }
    try {
      const attachment = await uploadCardAttachment({
        cardId: args.cardId.trim(),
        name: args.name.trim(),
        mimeType: args.mimeType,
        contentBase64: args.contentBase64
      })
      return { ok: true as const, attachment }
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : 'Attachment upload failed.'
      }
    }
  })

  ipcMain.handle('trello:downloadImage', async (_event, args: { url: string }) => {
    if (typeof args?.url !== 'string' || !args.url.trim()) {
      return { ok: false as const, error: 'Image URL is required.' }
    }
    try {
      const result = await trelloDownload(args.url.trim())
      return { ok: true as const, ...result }
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : 'Image download failed.'
      }
    }
  })
}
