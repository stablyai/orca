import type { BusinessmapBoard } from '../../shared/businessmap-types'
import { acquire, release } from './request-queue'
import {
  asNumber,
  asRecord,
  asString,
  businessmapRead,
  isAuthError,
  unwrapList,
  unwrapSingle
} from './authenticated-request'
import { clearToken, getClients } from './client'

export type BusinessmapBoardTree = {
  boardId: number
  workflows: { id: number; name: string }[]
  columnsById: Record<number, { id: number; name: string; workflowId: number }>
  lanesById: Record<number, { id: number; name: string }>
  defaultColumnId: number | null
  defaultLaneId: number | null
}

const BOARD_TREE_TTL_MS = 60 * 60 * 1000
const boardTreeCache = new Map<string, { tree: BusinessmapBoardTree; expiresAt: number }>()

function treeCacheKey(siteId: string, boardId: number): string {
  return `${siteId}\n${boardId}`
}

// Test seam: clears the 1h board-tree cache between cases.
export function _resetBoardTreeCacheForTests(): void {
  boardTreeCache.clear()
}

function mapBoard(raw: unknown): BusinessmapBoard | null {
  const record = asRecord(raw)
  const id = asNumber(record.board_id ?? record.id)
  const name = asString(record.name ?? record.title)
  if (id === null || !name) {
    return null
  }
  return { id, name }
}

export async function listBoards(siteId?: string | null): Promise<BusinessmapBoard[]> {
  const entries = getClients(siteId ?? undefined)
  if (entries.length === 0) {
    return []
  }
  const results = await Promise.all(
    entries.map(async (entry) => {
      await acquire()
      try {
        const payload = await businessmapRead(entry, '/boards')
        return unwrapList(payload)
          .map((item) => mapBoard(item))
          .filter((board): board is BusinessmapBoard => board !== null)
      } catch (error) {
        if (isAuthError(error)) {
          clearToken(entry.site.id)
          if (entries.length <= 1) {
            throw error
          }
        } else {
          console.warn('[businessmap] listBoards failed:', error)
        }
        return []
      } finally {
        release()
      }
    })
  )
  return results.flat().sort((left, right) => left.name.localeCompare(right.name))
}

// Indexed objects (not arrays): workflows/columns/lanes arrive keyed by ID.
function entriesOf(value: unknown): [string, Record<string, unknown>][] {
  const record = asRecord(value)
  return Object.entries(record).map(([key, entry]) => [key, asRecord(entry)])
}

function buildBoardTree(boardId: number, structure: Record<string, unknown>): BusinessmapBoardTree {
  const workflows = entriesOf(structure.workflows).map(([key, workflow]) => ({
    id: asNumber(workflow.workflow_id ?? workflow.id) ?? Number(key),
    name: asString(workflow.name)
  }))
  const columnsById: BusinessmapBoardTree['columnsById'] = {}
  for (const [key, column] of entriesOf(structure.columns)) {
    // Parent id distinguishes workflow-level columns from sub-columns; fall back to key.
    const id = asNumber(column.column_id ?? column.id) ?? Number(key)
    if (!Number.isFinite(id)) {
      continue
    }
    columnsById[id] = {
      id,
      name: asString(column.name),
      // Current API names the parent parent_column_id; older payloads use parent_id.
      workflowId:
        asNumber(column.workflow_id) ??
        asNumber(column.parent_column_id ?? column.parent_id) ??
        workflows[0]?.id ??
        0
    }
  }
  const lanesById: BusinessmapBoardTree['lanesById'] = {}
  for (const [key, lane] of entriesOf(structure.lanes)) {
    const id = asNumber(lane.lane_id ?? lane.id) ?? Number(key)
    if (!Number.isFinite(id)) {
      continue
    }
    lanesById[id] = { id, name: asString(lane.name) }
  }
  const columnIds = Object.keys(columnsById).map(Number)
  const laneIds = Object.keys(lanesById).map(Number)
  return {
    boardId,
    workflows,
    columnsById,
    lanesById,
    defaultColumnId: columnIds.length > 0 ? columnIds[0] : null,
    defaultLaneId: laneIds.length > 0 ? laneIds[0] : null
  }
}

// Board structure is near-static; cache per account for 1h to avoid refetching per card.
export async function getBoardTree(
  boardId: number,
  siteId?: string | null
): Promise<BusinessmapBoardTree | null> {
  const entries = getClients(siteId ?? undefined)
  const entry = entries[0]
  if (!entry) {
    return null
  }
  const key = treeCacheKey(entry.site.id, boardId)
  const cached = boardTreeCache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.tree
  }
  await acquire()
  try {
    const payload = await businessmapRead(entry, `/boards/${boardId}/currentStructure`)
    const tree = buildBoardTree(boardId, unwrapSingle(payload))
    boardTreeCache.set(key, { tree, expiresAt: Date.now() + BOARD_TREE_TTL_MS })
    return tree
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.site.id)
      throw error
    }
    console.warn('[businessmap] getBoardTree failed:', error)
    return null
  } finally {
    release()
  }
}
