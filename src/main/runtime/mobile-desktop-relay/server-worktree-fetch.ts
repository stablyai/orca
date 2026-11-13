import { z } from 'zod'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import {
  isWorktreeCatalogRow,
  worktreeCatalogRowDelta
} from '../../../shared/worktree/catalog-row-delta'

// Default pages stop at 200; the phone has no pagination.
export const SERVER_WORKTREE_LIMIT = 10_000
// Stay below the phone 30s timeout so hung servers can fall back to cached rows.
export const SERVER_FETCH_TIMEOUT_MS = 5_000

export const WorktreePsReplySchema = z.object({ worktrees: z.array(z.looseObject({})) })

export type ServerWorktreeRow = { [key: string]: unknown; worktreeId: string }

/** A server's worktree.ps read as row deltas on top of the rows held from its last answer. */
export const serverRowDeltas = worktreeCatalogRowDelta((row): row is ServerWorktreeRow =>
  isWorktreeCatalogRow(row)
)

/** Collapse server-relative local/SSH hosts to the server id, matching the desktop sidebar. */
export function stampServerWorktreeRows<Row extends object>(
  environmentId: string,
  rows: readonly Row[]
): (Row & { hostId: `runtime:${string}` })[] {
  const hostId = toRuntimeExecutionHostId(environmentId)
  return rows.map((row) => ({ ...row, hostId }))
}
