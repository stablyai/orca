import type {
  BusinessmapComment,
  BusinessmapCreateCardArgs,
  BusinessmapCreateCardResult,
  BusinessmapCardUpdate,
  BusinessmapMutationResult
} from '../../shared/businessmap-types'
import { getBoardTree } from './boards'
import { acquire, release } from './request-queue'
import {
  asRecord,
  asString,
  businessmapRead,
  businessmapRequest,
  isAuthError,
  unwrapList,
  unwrapSingle
} from './authenticated-request'
import type { ApiRecord, BusinessmapClientForSite } from './authenticated-request'
import { asId, cardUrl, getClientEntries, mapComment } from './card-read'
import { clearToken } from './client'

async function resolveColumnLane(
  boardId: number,
  siteId: string,
  columnId: number | undefined,
  laneId: number | undefined
): Promise<{ ok: true; columnId: number; laneId: number | null } | { ok: false; error: string }> {
  const tree = await getBoardTree(boardId, siteId)
  if (!tree) {
    return { ok: false, error: 'Board structure is unavailable.' }
  }
  if (columnId !== undefined && tree.columnsById[columnId] === undefined) {
    return { ok: false, error: 'Column does not exist on this board.' }
  }
  if (laneId !== undefined && tree.lanesById[laneId] === undefined) {
    return { ok: false, error: 'Lane does not exist on this board.' }
  }
  if (columnId === undefined) {
    // Without an explicit column the target is ambiguous on multi-workflow boards.
    if (tree.workflows.length > 1) {
      return { ok: false, error: 'Board has multiple workflows; specify a column.' }
    }
    const fallback = tree.defaultColumnId
    if (fallback === null) {
      return { ok: false, error: 'Board has no columns to place the card in.' }
    }
    return { ok: true, columnId: fallback, laneId: laneId ?? tree.defaultLaneId }
  }
  return { ok: true, columnId, laneId: laneId ?? null }
}

function firstEntry(siteId?: string | null): BusinessmapClientForSite | undefined {
  return getClientEntries(siteId)[0]
}

// Creates a card; POST must never retry (a 5xx may have persisted the card).
export async function createCard(
  args: BusinessmapCreateCardArgs,
  siteId?: string | null
): Promise<BusinessmapCreateCardResult> {
  const entry = firstEntry(siteId)
  if (!entry) {
    return { ok: false, error: 'Not connected to Businessmap.' }
  }
  const title = args.title.trim()
  if (!title) {
    return { ok: false, error: 'Title is required.' }
  }
  // Placement first: getBoardTree takes its own queue slot, so holding one here would deadlock.
  const placement = await resolveColumnLane(
    args.boardId,
    entry.site.id,
    args.columnId,
    args.laneId
  )
  if (!placement.ok) {
    return placement
  }
  await acquire()
  try {
    // Board is implicit in the target column; POST /cards takes no board_id.
    const body: Record<string, unknown> = {
      title,
      column_id: placement.columnId
    }
    if (args.description?.trim()) {
      body.description = args.description.trim()
    }
    if (placement.laneId !== null) {
      body.lane_id = placement.laneId
    }
    const created = unwrapSingle(
      await businessmapRequest(entry, '/cards', { method: 'POST', body: JSON.stringify(body) })
    )
    const id = asId(asRecord(created).card_id ?? asRecord(created).id)
    if (id === null) {
      return { ok: false, error: 'Card creation returned no id.' }
    }
    return { ok: true, id, url: cardUrl(entry.site, args.boardId, id) }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to create card.' }
  } finally {
    release()
  }
}

// Updates title/description and moves columns/lanes; PATCH must never retry.
export async function updateCard(
  id: number,
  updates: BusinessmapCardUpdate,
  siteId?: string | null
): Promise<BusinessmapMutationResult> {
  const entry = firstEntry(siteId)
  if (!entry) {
    return { ok: false, error: 'Not connected to Businessmap.' }
  }
  // Resolve the move target before taking a slot; the lookups below take their own slots.
  let move: { columnId: number; laneId: number | null; reason?: string } | null = null
  if (updates.columnId !== undefined || updates.laneId !== undefined) {
    await acquire()
    let current: ApiRecord
    try {
      current = unwrapSingle(
        await businessmapRead(entry, `/cards/${id}?fields=card_id,board_id,column_id,lane_id`)
      )
    } catch (error) {
      release()
      if (isAuthError(error)) {
        clearToken(entry.site.id)
        throw error
      }
      return { ok: false, error: error instanceof Error ? error.message : 'Failed to update card.' }
    }
    release()
    const boardId = asId(current.board_id)
    if (boardId === null) {
      return { ok: false, error: 'Card board is unknown; cannot move.' }
    }
    const placement = await resolveColumnLane(
      boardId,
      entry.site.id,
      updates.columnId,
      updates.laneId
    )
    if (!placement.ok) {
      return placement
    }
    move = { columnId: placement.columnId, laneId: placement.laneId }
    if (updates.reason?.trim()) {
      move.reason = updates.reason.trim()
    }
  }
  await acquire()
  try {
    const body: Record<string, unknown> = {}
    if (updates.title !== undefined) {
      body.title = updates.title
    }
    if (updates.description !== undefined) {
      body.description = updates.description
    }
    if (move !== null) {
      body.column_id = move.columnId
      if (move.laneId !== null) {
        body.lane_id = move.laneId
      }
      if (move.reason !== undefined) {
        // PATCH /cards moves with exceeding_reason, not move_reason.
        body.exceeding_reason = move.reason
      }
    }
    await businessmapRequest(entry, `/cards/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
    return { ok: true }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to update card.' }
  } finally {
    release()
  }
}

// Adds a comment; POST must never retry (a 5xx may have persisted the comment).
export async function addCardComment(
  id: number,
  body: string,
  siteId?: string | null
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const entry = firstEntry(siteId)
  if (!entry) {
    return { ok: false, error: 'Not connected to Businessmap.' }
  }
  await acquire()
  try {
    const created = unwrapSingle(
      await businessmapRequest(entry, `/cards/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ text: body })
      })
    )
    const commentId = asId(asRecord(created).comment_id ?? asRecord(created).id)
    if (commentId === null) {
      return { ok: false, error: 'Comment creation returned no id.' }
    }
    return { ok: true, id: commentId }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to add comment.' }
  } finally {
    release()
  }
}

export async function getCardComments(
  id: number,
  siteId?: string | null
): Promise<BusinessmapComment[]> {
  const entry = firstEntry(siteId)
  if (!entry) {
    return []
  }
  await acquire()
  try {
    const payload = await businessmapRead(entry, `/cards/${id}/comments`)
    return unwrapList(payload)
      .map((raw) => mapComment(asRecord(raw)))
      .filter((comment): comment is BusinessmapComment => comment !== null)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[businessmap] getCardComments failed:', error)
    return []
  } finally {
    release()
  }
}

// Single GET /users for assignee pickers; one call, never one lookup per card.
export async function listAssignableUsers(
  _boardId: number,
  siteId?: string | null
): Promise<{ id: number; displayName: string }[]> {
  const entry = firstEntry(siteId)
  if (!entry) {
    return []
  }
  await acquire()
  try {
    // GET /users takes no board filter; fetch the directory once for pickers.
    const params = new URLSearchParams({
      fields: 'user_id,realname,email'
    })
    const payload = await businessmapRead(entry, `/users?${params.toString()}`)
    const users: { id: number; displayName: string }[] = []
    for (const raw of unwrapList(payload)) {
      const record = asRecord(raw)
      const userId = asId(record.user_id ?? record.id)
      if (userId === null) {
        continue
      }
      users.push({
        id: userId,
        displayName: asString(record.realname) || asString(record.email) || String(userId)
      })
    }
    return users.sort((left, right) => left.displayName.localeCompare(right.displayName))
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[businessmap] listAssignableUsers failed:', error)
    return []
  } finally {
    release()
  }
}
