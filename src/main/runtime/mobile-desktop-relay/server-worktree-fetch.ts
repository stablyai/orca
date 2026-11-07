import { z } from 'zod'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'

// Default pages stop at 200; the phone has no pagination.
export const SERVER_WORKTREE_LIMIT = 10_000
// Stay below the phone 30s timeout so hung servers can fall back to cached rows.
export const SERVER_FETCH_TIMEOUT_MS = 5_000

export const WorktreePsReplySchema = z.object({ worktrees: z.array(z.looseObject({})) })

/** Collapse server-relative local/SSH hosts to the server id, matching the desktop sidebar. */
export function stampServerWorktreeRows<Row extends { hostId?: string }>(
  environmentId: string,
  rows: readonly Row[]
): (Row & { hostId: `runtime:${string}` })[] {
  const hostId = toRuntimeExecutionHostId(environmentId)
  return rows.map((row) => ({ ...row, hostId }))
}
