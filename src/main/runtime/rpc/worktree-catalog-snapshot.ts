import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type {
  RuntimeWorktreePsConditionalResult,
  RuntimeWorktreePsResult
} from '../../../shared/runtime-types'

// Why: 192 bits of a sha256 over the serialized catalog. Accidental collision is
// impossible at any realistic poll rate, and this is not an auth boundary.
const SNAPSHOT_ID_LENGTH = 32

type MemoizedCatalogId = {
  result: RuntimeWorktreePsResult
  snapshotId: string
}

// Why: a pure memo over the most recent catalog. Because ids are derived from content
// rather than from cache state, dropping or thrashing this slot costs CPU and nothing
// else — it can never produce a wrong answer, so it needs no scoping, eviction policy,
// or per-caller isolation. Serializing every poll instead would cost ~3x the compare.
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
  // Why: caller-owned mutation must not let an old id label new catalog content.
  memoizedId = { result: JSON.parse(serialized) as RuntimeWorktreePsResult, snapshotId }
  return snapshotId
}

// Why: content-addressed like an HTTP ETag, so snapshot ownership lives entirely in the
// id. Any number of concurrent clients, any `limit`, and any runtime restart stay correct
// by construction: ids match only when the catalogs are byte-identical, which is exactly
// when `unchanged` is the right answer.
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
