import { sortByUpdatedAtDescending } from '../../shared/updated-at-order'
import type { BusinessmapCard, BusinessmapCardFilter } from '../../shared/businessmap-types'
import { acquire, release } from './request-queue'
import { asRecord, businessmapRead, isAuthError, unwrapSingle } from './authenticated-request'
import type { BusinessmapClientForSite } from './authenticated-request'
import {
  CARD_FIELDS,
  asId,
  clampLimit,
  currentUserId,
  fetchCardPages,
  filterParams,
  getClientEntries,
  loadNameTables,
  mapCard,
  surfaceReadError
} from './card-read'
import { clearToken } from './client'

async function listCardsForEntry(
  entry: BusinessmapClientForSite,
  filter: BusinessmapCardFilter,
  boardId: number | null,
  maxRows: number
): Promise<BusinessmapCard[]> {
  const viewerId = filter === 'assigned' ? await currentUserId(entry) : null
  const raws = await fetchCardPages(entry, filterParams(filter, viewerId), boardId, maxRows)
  const names = await loadNameTables(entry, raws, boardId)
  return raws
    .map((raw) => mapCard(entry.site, raw, names, boardId))
    .filter((card): card is BusinessmapCard => card !== null)
}

export async function listCards(
  filter: BusinessmapCardFilter = 'assigned',
  limit = 30,
  siteId?: string | null,
  boardId?: number | null
): Promise<BusinessmapCard[]> {
  const entries = getClientEntries(siteId)
  if (entries.length === 0) {
    return []
  }
  const safeLimit = clampLimit(limit)
  const board = boardId ?? null
  const results = await Promise.all(
    entries.map(async (entry) => {
      try {
        return await listCardsForEntry(entry, filter, board, safeLimit)
      } catch (error) {
        return surfaceReadError(error, entry, entries.length)
      }
    })
  )
  const cards = results.flat()
  if (entries.length === 1) {
    return cards.slice(0, safeLimit)
  }
  return sortByUpdatedAtDescending(cards).slice(0, safeLimit)
}

export async function searchCards(
  query: string,
  limit = 30,
  siteId?: string | null,
  boardId?: number | null
): Promise<BusinessmapCard[]> {
  const trimmed = query.trim()
  if (!trimmed) {
    return []
  }
  const entries = getClientEntries(siteId)
  if (entries.length === 0) {
    return []
  }
  const safeLimit = clampLimit(limit)
  const board = boardId ?? null
  const numericId = /^\d+$/.test(trimmed) ? Number(trimmed) : null
  const results = await Promise.all(
    entries.map(async (entry) => {
      try {
        const params = new URLSearchParams({ fields: CARD_FIELDS, per_page: '100' })
        if (board !== null) {
          params.set('board_ids', String(board))
        }
        if (numericId !== null) {
          params.set('card_ids', String(numericId))
        } else {
          params.set('search', trimmed)
        }
        const raws = await fetchCardPages(entry, params, board)
        const names = await loadNameTables(entry, raws, board)
        const cards = raws
          .map((raw) => mapCard(entry.site, raw, names, board))
          .filter((card): card is BusinessmapCard => card !== null)
        if (numericId !== null) {
          return cards
        }
        const lowered = trimmed.toLowerCase()
        return cards.filter(
          (card) =>
            card.title.toLowerCase().includes(lowered) ||
            (card.description ?? '').toLowerCase().includes(lowered)
        )
      } catch (error) {
        return surfaceReadError(error, entry, entries.length)
      }
    })
  )
  const cards = results.flat()
  if (entries.length === 1) {
    return cards.slice(0, safeLimit)
  }
  return sortByUpdatedAtDescending(cards).slice(0, safeLimit)
}

export async function getCard(id: number, siteId?: string | null): Promise<BusinessmapCard | null> {
  const entries = getClientEntries(siteId)
  for (const entry of entries) {
    await acquire()
    let raw: unknown
    try {
      const params = new URLSearchParams({ fields: CARD_FIELDS })
      raw = await businessmapRead(entry, `/cards/${id}?${params.toString()}`)
    } catch (error) {
      release()
      if (isAuthError(error)) {
        clearToken(entry.site.id)
        if (entries.length <= 1) {
          throw error
        }
      } else {
        console.warn('[businessmap] getCard failed:', error)
      }
      continue
    }
    release()
    const single = unwrapSingle(raw)
    const names = await loadNameTables(entry, [single], asId(asRecord(single).board_id))
    return mapCard(entry.site, single, names, null)
  }
  return null
}

// End of card queries.
