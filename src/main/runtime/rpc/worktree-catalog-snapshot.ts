import { createHash } from 'node:crypto'
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

// Use 192 SHA-256 bits for practical collision resistance; this is catalog identity, not authentication.
const SNAPSHOT_ID_LENGTH = 32
// Why: home, the host screen and other phones each poll their own base; a dozen covers them without holding rows.
const RECENT_SNAPSHOT_LIMIT = 16

// Row hashes only, never row content: eviction costs one full reply, never correctness.
const recentRowHashes = new Map<string, readonly string[]>()

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url').slice(0, SNAPSHOT_ID_LENGTH)
}

function identify(result: Catalog): {
  snapshotId: string
  rowHashes: string[]
} {
  const rowHashes = result.worktrees.map((row) => digest(JSON.stringify(row)))
  const snapshotId = digest(JSON.stringify({ ...result, worktrees: rowHashes }))
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

// ETag-style content identity survives concurrency, limits and restarts; unchanged is valid exactly when serialized catalogs match.
export function resolveWorktreeCatalogSnapshot<Result extends Catalog>(
  result: Result,
  afterSnapshotId: string | null,
  options?: { acceptRowDelta?: boolean }
): WorktreeCatalogSnapshotReply<Result> {
  const { snapshotId, rowHashes } = identify(result)
  const baseRowHashes =
    options?.acceptRowDelta === true && afterSnapshotId !== null
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
