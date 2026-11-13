import { z } from 'zod'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import {
  isWorktreeCatalogRow,
  worktreeCatalogRowDelta,
  type WorktreeCatalogSnapshot
} from '../../../shared/worktree/catalog-row-delta'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

// Default pages stop at 200; the phone has no pagination.
export const SERVER_WORKTREE_LIMIT = 10_000
// Stay below the phone 30s timeout so hung servers can fall back to cached rows.
export const SERVER_FETCH_TIMEOUT_MS = 5_000

export const WorktreePsReplySchema = z.object({ worktrees: z.array(z.looseObject({})) })

export type ServerWorktreeRow = { [key: string]: unknown; worktreeId: string }

const serverRowDeltas = worktreeCatalogRowDelta((row): row is ServerWorktreeRow =>
  isWorktreeCatalogRow(row)
)

/** A server's worktree.ps read as row deltas on top of `held`; null when the server is unreachable. */
export function readServerWorktreeRows(
  call: (method: string, params: unknown) => Promise<RuntimeRpcResponse<unknown>>,
  held: WorktreeCatalogSnapshot<ServerWorktreeRow> | null
) {
  return serverRowDeltas
    .read(async (snapshot) => {
      const response = await call('worktree.ps', {
        limit: SERVER_WORKTREE_LIMIT,
        supportsWorktreeVisibilitySourceDefaults: true,
        ...snapshot
      })
      return response.ok
        ? { accepted: true as const, value: response.result }
        : { accepted: false as const, code: 'request_failed' }
    }, held)
    .catch(() => null)
}

/** Collapse server-relative local/SSH hosts to the server id, matching the desktop sidebar. */
export function stampServerWorktreeRows<Row extends object>(
  environmentId: string,
  rows: readonly Row[]
): (Row & { hostId: `runtime:${string}` })[] {
  const hostId = toRuntimeExecutionHostId(environmentId)
  return rows.map((row) => ({ ...row, hostId }))
}
