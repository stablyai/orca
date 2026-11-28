import { isDeepStrictEqual } from 'node:util'
import { contentSnapshotId } from './content-snapshot-id'
// Any catalog of opaque rows: the desktop's own worktree.ps rows or a paired server's.
type Catalog = { worktrees: unknown[] }

export type WorktreeCatalogSnapshotReply<Result extends Catalog> =
  | (Result & { snapshotId: string })
  | { unchanged: true; snapshotId: string }
  | (Omit<Result, 'worktrees'> & {
      snapshotId: string
      baseSnapshotId: string
      rowsFromBase: (number | Result['worktrees'][number])[]
    })

// Why: home, the host screen and other phones each poll their own base; 16 covers them without holding rows.
const RECENT_SNAPSHOT_LIMIT = 16

// Row hashes only, never row content: eviction costs one full reply, never correctness.
const recentRowHashes = new Map<string, readonly string[]>()

type CachedSnapshot = {
  snapshotId: string
  envelope: Record<string, unknown>
  rows: readonly unknown[]
  rowHashes: readonly string[]
}

function cloneForCache<T>(value: T): { ok: true; value: T } | { ok: false } {
  if (typeof value !== 'object' || value === null) {
    return { ok: true, value }
  }
  try {
    return { ok: true, value: structuredClone(value) }
  } catch {
    return { ok: false }
  }
}

function cloneEnvelope(
  result: Catalog
): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const envelope: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(result)) {
    if (key === 'worktrees') {
      continue
    }
    const cloned = cloneForCache(value)
    if (!cloned.ok) {
      return cloned
    }
    envelope[key] = cloned.value
  }
  return { ok: true, value: envelope }
}

function sameEnvelope(result: Catalog, cachedEnvelope: Record<string, unknown>): boolean {
  const cachedKeys = Object.keys(cachedEnvelope)
  let extraCount = 0
  for (const [key, value] of Object.entries(result)) {
    if (key === 'worktrees') {
      continue
    }
    extraCount += 1
    if (!Object.hasOwn(cachedEnvelope, key) || !isDeepStrictEqual(value, cachedEnvelope[key])) {
      return false
    }
  }
  return extraCount === cachedKeys.length
}

/**
 * One catalog's row hashes and last snapshot identity from its last reply. Rows arrive as new
 * objects on every fetch, so equal rows reuse their hash (a one-row change hashes one row, not
 * all) and an unchanged catalog reuses its snapshot id without serializing or hashing.
 */
export class WorktreeCatalogRowHashes {
  private byId = new Map<string, { row: unknown; hash: string }>()
  private lastSnapshot: CachedSnapshot | null = null

  hash(rows: readonly unknown[]): string[] {
    const { rowHashes } = this.hashRows(rows)
    this.lastSnapshot = null
    return rowHashes
  }

  identify(result: Catalog): {
    snapshotId: string
    rowHashes: readonly string[]
  } {
    const { rowHashes, cachedRows, allRowsSamePosition, cacheableRows } = this.hashRows(
      result.worktrees
    )
    if (
      allRowsSamePosition &&
      this.lastSnapshot !== null &&
      sameEnvelope(result, this.lastSnapshot.envelope)
    ) {
      return {
        snapshotId: this.lastSnapshot.snapshotId,
        rowHashes: this.lastSnapshot.rowHashes
      }
    }
    const snapshotId = contentSnapshotId(JSON.stringify({ ...result, worktrees: rowHashes }))
    const envelope = cacheableRows ? cloneEnvelope(result) : { ok: false as const }
    this.lastSnapshot = envelope.ok
      ? { snapshotId, envelope: envelope.value, rows: cachedRows, rowHashes }
      : null
    return { snapshotId, rowHashes }
  }

  private hashRows(rows: readonly unknown[]): {
    rowHashes: string[]
    cachedRows: unknown[]
    allRowsSamePosition: boolean
    cacheableRows: boolean
  } {
    const prevSnapshot = this.lastSnapshot
    let allRowsSamePosition = prevSnapshot !== null && prevSnapshot.rows.length === rows.length
    let cacheableRows = true
    const next = new Map<string, { row: unknown; hash: string }>()
    const cachedRows: unknown[] = []
    const rowHashes = rows.map((row, index) => {
      const id =
        typeof row === 'object' && row !== null && 'worktreeId' in row ? row.worktreeId : undefined
      const hasPrevAtIndex = prevSnapshot !== null && index < prevSnapshot.rows.length
      const prevAtIndex = hasPrevAtIndex ? prevSnapshot.rows[index] : undefined
      if (hasPrevAtIndex && isDeepStrictEqual(prevAtIndex, row)) {
        const hash = prevSnapshot.rowHashes[index]!
        cachedRows[index] = prevAtIndex
        if (typeof id === 'string' && !next.has(id)) {
          next.set(id, { row: prevAtIndex, hash })
        }
        return hash
      }
      allRowsSamePosition = false
      const last = typeof id === 'string' ? this.byId.get(id) : undefined
      if (
        last &&
        (!hasPrevAtIndex || last.row !== prevAtIndex) &&
        isDeepStrictEqual(last.row, row)
      ) {
        cachedRows[index] = last.row
        if (typeof id === 'string' && !next.has(id)) {
          next.set(id, last)
        }
        return last.hash
      }
      const hash = contentSnapshotId(JSON.stringify(row))
      const cloned = cloneForCache(row)
      if (cloned.ok) {
        cachedRows[index] = cloned.value
        if (typeof id === 'string' && !next.has(id)) {
          next.set(id, { row: cloned.value, hash })
        }
      } else {
        cacheableRows = false
      }
      return hash
    })
    // Only the latest reply's rows are kept, so a removed row is not held.
    this.byId = next
    return { rowHashes, cachedRows, allRowsSamePosition, cacheableRows }
  }
}

const defaultCatalogRowHashes = new WorktreeCatalogRowHashes()

function identify(
  result: Catalog,
  memo: WorktreeCatalogRowHashes | undefined
): {
  snapshotId: string
  rowHashes: readonly string[]
} {
  return (memo ?? defaultCatalogRowHashes).identify(result)
}

function remember(snapshotId: string, rowHashes: readonly string[]): void {
  // Delete before set so the entry moves to the newest LRU position.
  recentRowHashes.delete(snapshotId)
  recentRowHashes.set(snapshotId, rowHashes)
  if (recentRowHashes.size > RECENT_SNAPSHOT_LIMIT) {
    const oldest = recentRowHashes.keys().next().value
    if (oldest !== undefined) {
      recentRowHashes.delete(oldest)
    }
  }
}

function rowsFromBase<Row>(
  result: { worktrees: Row[] },
  rowHashes: readonly string[],
  baseRowHashes: readonly string[]
): (number | Row)[] {
  const baseIndexByHash = new Map<string, number>()
  baseRowHashes.forEach((hash, index) => {
    if (!baseIndexByHash.has(hash)) {
      baseIndexByHash.set(hash, index)
    }
  })
  return result.worktrees.map((row, index) => baseIndexByHash.get(rowHashes[index]!) ?? row)
}

export type WorktreeCatalogSnapshotParams = {
  afterSnapshotId?: string | null
  acceptRowDelta?: true
}

// ETag-style content identity survives concurrency, limits and restarts; unchanged is valid exactly when serialized catalogs match.
// Why: callers that send neither field get the byte-exact legacy reply.
export function resolveWorktreeCatalogSnapshot<Result extends Catalog>(
  result: Result,
  params: { afterSnapshotId: string | null; acceptRowDelta?: true },
  rowHashes?: WorktreeCatalogRowHashes
): WorktreeCatalogSnapshotReply<Result>
export function resolveWorktreeCatalogSnapshot<Result extends Catalog>(
  result: Result,
  params: WorktreeCatalogSnapshotParams,
  rowHashes?: WorktreeCatalogRowHashes
): Result | WorktreeCatalogSnapshotReply<Result>
export function resolveWorktreeCatalogSnapshot<Result extends Catalog>(
  result: Result,
  params: WorktreeCatalogSnapshotParams,
  memo?: WorktreeCatalogRowHashes
): Result | WorktreeCatalogSnapshotReply<Result> {
  if (params.afterSnapshotId === undefined && params.acceptRowDelta !== true) {
    return result
  }
  const afterSnapshotId = params.afterSnapshotId ?? null
  const { snapshotId, rowHashes } = identify(result, memo)
  const baseRowHashes =
    params.acceptRowDelta === true && afterSnapshotId !== null
      ? recentRowHashes.get(afterSnapshotId)
      : undefined
  remember(snapshotId, rowHashes)
  if (afterSnapshotId === snapshotId) {
    return { unchanged: true, snapshotId }
  }
  if (afterSnapshotId !== null && baseRowHashes) {
    const { worktrees: _worktrees, ...envelope } = result
    return {
      ...envelope,
      snapshotId,
      baseSnapshotId: afterSnapshotId,
      rowsFromBase: rowsFromBase(result, rowHashes, baseRowHashes)
    }
  }
  return { ...result, snapshotId }
}
