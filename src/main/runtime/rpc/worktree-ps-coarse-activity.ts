import type { RuntimeWorktreePsResult } from '../../../shared/runtime-types'
import { compareWorktreePs } from '../runtime-worktree-status-projection'

// Why: mobile reads lastOutputAt only to rank rows; a 30 s floor bounds activity-driven resends to one per bucket.
const COARSE_LAST_OUTPUT_AT_MS = 30_000

/** Blanks what moves on every PTY chunk: `preview` and sub-bucket `lastOutputAt`. */
export function coarsenWorktreePsActivity(
  result: RuntimeWorktreePsResult
): RuntimeWorktreePsResult {
  return {
    ...result,
    worktrees: result.worktrees
      .map((row) => ({
        ...row,
        preview: '',
        lastOutputAt:
          row.lastOutputAt === null
            ? null
            : Math.floor(row.lastOutputAt / COARSE_LAST_OUTPUT_AT_MS) * COARSE_LAST_OUTPUT_AT_MS
      }))
      // Why: rows ranked by raw lastOutputAt would trade places inside one bucket and move the id.
      .sort(compareWorktreePs)
  }
}
