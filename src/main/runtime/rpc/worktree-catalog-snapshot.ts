import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type {
  RuntimeWorktreePsConditionalResult,
  RuntimeWorktreePsResult
} from '../../../shared/runtime-types'

// Use 192 SHA-256 bits for practical collision resistance; this is catalog identity, not authentication.
const SNAPSHOT_ID_LENGTH = 32

type MemoizedCatalogId = {
  result: RuntimeWorktreePsResult
  snapshotId: string
}

// Content-derived ids make this memo disposable: eviction costs CPU, never correctness; serializing each poll costs ~3× comparison.
let memoizedId: MemoizedCatalogId | null = null

function worktreeCatalogSnapshotId(result: RuntimeWorktreePsResult): string {
  if (memoizedId && isDeepStrictEqual(memoizedId.result, result)) {
    return memoizedId.snapshotId
  }
  const serialized = JSON.stringify(result)
  const snapshotId = createHash('sha256')
    .update(serialized)
    .digest('base64url')
    .slice(0, SNAPSHOT_ID_LENGTH)
  // Clone so caller mutation cannot give new content an old id.
  memoizedId = { result: JSON.parse(serialized) as RuntimeWorktreePsResult, snapshotId }
  return snapshotId
}

// ETag-style content identity survives concurrency, limits and restarts; unchanged is valid exactly when serialized catalogs match.
export function resolveWorktreeCatalogSnapshot(
  result: RuntimeWorktreePsResult,
  afterSnapshotId: string | null
): RuntimeWorktreePsConditionalResult {
  const snapshotId = worktreeCatalogSnapshotId(result)
  if (afterSnapshotId === snapshotId) {
    return { unchanged: true, snapshotId }
  }
  return { ...result, snapshotId }
}
