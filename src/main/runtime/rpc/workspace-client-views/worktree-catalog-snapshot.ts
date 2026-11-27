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

/**
 * One catalog's row hashes from its last reply, by worktree id. Rows arrive as new objects on every
 * fetch, so a row equal by value to its last copy (key order aside) reuses that hash: a one-row
 * change hashes one row, not all.
 */
export class WorktreeCatalogRowHashes {
  private byId = new Map<string, { row: unknown; hash: string }>()

  hash(rows: readonly unknown[]): string[] {
    const next = new Map<string, { row: unknown; hash: string }>()
    const hashes = rows.map((row) => {
      const id =
        typeof row === 'object' && row !== null && 'worktreeId' in row ? row.worktreeId : undefined
      const last = typeof id === 'string' ? this.byId.get(id) : undefined
      const hash =
        last && isDeepStrictEqual(last.row, row)
          ? last.hash
          : contentSnapshotId(JSON.stringify(row))
      if (typeof id === 'string' && !next.has(id)) {
        next.set(id, { row, hash })
      }
      return hash
    })
    // Only the latest reply's rows are kept, so a removed row is not held.
    this.byId = next
    return hashes
  }
}

function identify(
  result: Catalog,
  memo: WorktreeCatalogRowHashes | undefined
): {
  snapshotId: string
  rowHashes: string[]
} {
  const rowHashes = memo
    ? memo.hash(result.worktrees)
    : result.worktrees.map((row) => contentSnapshotId(JSON.stringify(row)))
  const snapshotId = contentSnapshotId(JSON.stringify({ ...result, worktrees: rowHashes }))
  return { snapshotId, rowHashes }
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
