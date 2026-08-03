import type { IPtyProvider } from '../providers/types'
import { UNSTOPPED_PTY_REMOVAL_PREFIX } from '../../shared/worktree-removal'
import { settleBeforeDeadline } from './settle-before-deadline'

// Floor for the verification window when the sweep ran on a very short budget.
export const WORKTREE_TEARDOWN_VERIFY_GRACE_MS = 2_000

export type UnstoppedPtyVerdict =
  | { status: 'exited' }
  | { status: 'live'; ptyIds: string[] }
  | { status: 'unverifiable'; reason: string }

/**
 * Re-lists the provider's processes to decide what a failed stop RPC actually
 * meant. The three verdicts stay distinct on purpose: "we could not ask" is not
 * evidence that a PTY survived, and callers word their errors differently.
 *
 * Why (#11960): this re-list used to run on the sweep's own deadline, which the
 * sweeps had normally just spent. An inventory that answers perfectly well in
 * 1s then "timed out" against a 0ms budget, so a PTY that had already exited
 * read as unverifiable and the workspace could never be removed. Verification
 * gets a budget of its own, sized like the sweep's rather than its leftovers.
 */
export async function verifyUnstoppedPtys(
  failedPtyIds: readonly string[],
  provider: IPtyProvider,
  sweepBudgetMs: number
): Promise<UnstoppedPtyVerdict> {
  const verifyBudgetMs = Math.max(WORKTREE_TEARDOWN_VERIFY_GRACE_MS, sweepBudgetMs)
  const verifyDeadline = Date.now() + verifyBudgetMs
  let listError: unknown
  const sessions = await settleBeforeDeadline(
    async () => {
      try {
        return await provider.listProcesses({ deadlineMs: verifyDeadline })
      } catch (error) {
        listError = error
        return null
      }
    },
    null,
    verifyDeadline
  )
  if (!sessions) {
    return {
      status: 'unverifiable',
      reason: listError instanceof Error ? listError.message : 'the process list timed out'
    }
  }
  const livePtyIds = new Set(sessions.map((session) => session.id))
  const stillLive = failedPtyIds.filter((ptyId) => livePtyIds.has(ptyId))
  return stillLive.length > 0 ? { status: 'live', ptyIds: stillLive } : { status: 'exited' }
}

/** Names the blocking PTYs so a wedged removal is diagnosable, not just refused. */
export function describeUnstoppedPtys(
  worktreeId: string,
  failedPtyIds: readonly string[],
  verdict: Exclude<UnstoppedPtyVerdict, { status: 'exited' }>
): string {
  const detail =
    verdict.status === 'live'
      ? `still live: ${verdict.ptyIds.join(', ')}`
      : `could not verify these exited: ${failedPtyIds.join(', ')} (${verdict.reason})`
  return `${UNSTOPPED_PTY_REMOVAL_PREFIX} ${worktreeId} — ${detail}`
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
