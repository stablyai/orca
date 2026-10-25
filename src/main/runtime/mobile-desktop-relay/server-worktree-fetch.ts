import { z } from 'zod'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'

// Why the phone's own full-catalog limit: the server's default page is 200 and nothing pages on.
export const SERVER_WORKTREE_LIMIT = 10_000
// Why well under the phone's 30s request timeout: a hung server must answer with its last rows.
export const SERVER_FETCH_TIMEOUT_MS = 5_000

export const WorktreePsReplySchema = z.object({ worktrees: z.array(z.looseObject({})) })

/**
 * A server's rows name hosts relative to that server (`local`, its own `ssh:` targets). Like the
 * desktop sidebar, the phone shows every one of them under the server, so all become its host id.
 */
export function stampServerWorktreeRows<Row extends { hostId?: string }>(
  environmentId: string,
  rows: readonly Row[]
): (Row & { hostId: `runtime:${string}` })[] {
  const hostId = toRuntimeExecutionHostId(environmentId)
  return rows.map((row) => ({ ...row, hostId }))
}
