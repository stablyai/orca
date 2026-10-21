import { z } from 'zod'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { MachineWorkAtRisk } from '../../shared/machine-inventory'

type RuntimeCall = (
  method: string,
  params: unknown,
  timeoutMs: number
) => Promise<RuntimeRpcResponse<unknown>>

// Short: a warning about to fire must not wait out a slow host, and "couldn't check" is an answer.
const READ_TIMEOUT_MS = 5_000
const MAX_WORKTREES = 50

const worktreesSchema = z.object({
  worktrees: z.array(z.object({ worktreeId: z.string(), isArchived: z.boolean().optional() })),
  // Required: a listing that can't say it is complete can't back "nothing to lose".
  truncated: z.boolean()
})
const statusSchema = z.object({
  entries: z.array(z.unknown()),
  didHitLimit: z.boolean().optional(),
  statusLength: z.number().optional(),
  // Required: without it (an older host, a detached HEAD) unpushed work is unknown, not zero.
  upstreamStatus: z.object({ hasUpstream: z.boolean(), ahead: z.number() })
})

function resultOf<T>(response: RuntimeRpcResponse<unknown>, schema: z.ZodType<T>): T | null {
  if (!response.ok) {
    return null
  }
  const parsed = schema.safeParse(response.result)
  return parsed.success ? parsed.data : null
}

/**
 * Reads every worktree on the machine's Orca server (where a machine's worktrees live) and sums
 * their uncommitted entries, commits ahead of upstream, and branches never pushed. Any read that
 * fails or is incomplete (a truncated listing, a status without upstream data) makes the whole
 * answer null, so a warning never claims "nothing to lose" from partial evidence.
 */
export async function readMachineWorkAtRisk(call: RuntimeCall): Promise<MachineWorkAtRisk | null> {
  try {
    const listed = resultOf(
      await call(
        'worktree.ps',
        { limit: MAX_WORKTREES, supportsWorktreeVisibilitySourceDefaults: true },
        READ_TIMEOUT_MS
      ),
      worktreesSchema
    )
    if (!listed || listed.truncated) {
      return null
    }
    const statuses = await Promise.all(
      listed.worktrees
        .filter((worktree) => !worktree.isArchived)
        .map(async (worktree) =>
          resultOf(
            await call(
              'git.status',
              {
                worktree: `id:${worktree.worktreeId}`,
                admissionTier: 'background',
                includeLineStats: false
              },
              READ_TIMEOUT_MS
            ),
            statusSchema
          )
        )
    )
    if (statuses.some((status) => status === null)) {
      return null
    }
    return statuses.reduce<MachineWorkAtRisk>(
      (total, status) => ({
        uncommitted:
          total.uncommitted +
          (status?.didHitLimit && status.statusLength
            ? status.statusLength
            : (status?.entries.length ?? 0)),
        unpushed: total.unpushed + (status?.upstreamStatus.ahead ?? 0),
        // A branch with no upstream was never pushed: all of it is at risk, however many commits.
        neverPushed:
          (total.neverPushed ?? 0) + (status?.upstreamStatus.hasUpstream === false ? 1 : 0)
      }),
      { uncommitted: 0, unpushed: 0, neverPushed: 0 }
    )
  } catch {
    return null
  }
}
