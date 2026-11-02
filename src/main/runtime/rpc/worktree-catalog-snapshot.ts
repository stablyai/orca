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

function identify(result: Catalog): {
  snapshotId: string
  rowHashes: string[]
} {
  const rowHashes = result.worktrees.map((row) => contentSnapshotId(JSON.stringify(row)))
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
  params: { afterSnapshotId: string | null; acceptRowDelta?: true }
): WorktreeCatalogSnapshotReply<Result>
export function resolveWorktreeCatalogSnapshot<Result extends Catalog>(
  result: Result,
  params: WorktreeCatalogSnapshotParams
): Result | WorktreeCatalogSnapshotReply<Result>
export function resolveWorktreeCatalogSnapshot<Result extends Catalog>(
  result: Result,
  params: WorktreeCatalogSnapshotParams
): Result | WorktreeCatalogSnapshotReply<Result> {
  if (params.afterSnapshotId === undefined && params.acceptRowDelta !== true) {
    return result
  }
  const afterSnapshotId = params.afterSnapshotId ?? null
  const { snapshotId, rowHashes } = identify(result)
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
