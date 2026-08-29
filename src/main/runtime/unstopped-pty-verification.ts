import type { IPtyProvider } from '../providers/types'
import type { OrcaRuntimeService } from './orca-runtime'
import {
  UNSTOPPED_PTY_DETAIL_SEPARATOR,
  UNSTOPPED_PTY_LIVE_DETAIL_PREFIX,
  UNSTOPPED_PTY_REMOVAL_PREFIX
} from '../../shared/worktree/removal'
import {
  NO_OBSERVING_PROVIDER_REASON,
  type PtyLivenessVerdict
} from '../../shared/pty-liveness-verdict'
import { settleBeforeDeadline } from './settle-before-deadline'

// Floor for the verification window when the sweep ran on a very short budget.
export const WORKTREE_TEARDOWN_VERIFY_GRACE_MS = 2_000

export type UnstoppedPtyVerdict = PtyLivenessVerdict

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

/**
 * A stop that lost contact with the PTY's own host stays unverifiable: the
 * surviving provider's inventory is silent about a host it cannot reach, and
 * silence is not evidence of an exit. Force Delete is still the escape hatch.
 */
export function unverifiableStopVerdict(
  failedPtyIds: readonly string[],
  runtime: OrcaRuntimeService | undefined
): UnstoppedPtyVerdict | null {
  for (const ptyId of failedPtyIds) {
    const verdict = runtime?.getPtyLivenessVerdict?.(ptyId)
    if (verdict?.status === 'unverifiable') {
      return verdict
    }
  }
  return null
}

export async function resolveUnstoppedPtyVerdict(
  failedPtyIds: readonly string[],
  provider: IPtyProvider,
  sweepBudgetMs: number,
  providerObservesOwningHost: boolean,
  runtime?: OrcaRuntimeService
): Promise<UnstoppedPtyVerdict> {
  if (failedPtyIds.length === 0) {
    return { status: 'exited' }
  }
  if (!providerObservesOwningHost) {
    return (
      unverifiableStopVerdict(failedPtyIds, runtime) ?? {
        status: 'unverifiable',
        reason: NO_OBSERVING_PROVIDER_REASON
      }
    )
  }
  return verifyUnstoppedPtys(failedPtyIds, provider, sweepBudgetMs)
}

/** Names the blocking PTYs so a wedged removal is diagnosable, not just refused. */
export function describeUnstoppedPtys(
  worktreeId: string,
  failedPtyIds: readonly string[],
  verdict: Exclude<UnstoppedPtyVerdict, { status: 'exited' }>
): string {
  const detail =
    verdict.status === 'live'
      ? `${UNSTOPPED_PTY_LIVE_DETAIL_PREFIX} ${verdict.ptyIds.join(', ')}`
      : `could not verify these exited: ${failedPtyIds.join(', ')} (${verdict.reason})`
  return `${UNSTOPPED_PTY_REMOVAL_PREFIX} ${worktreeId}${UNSTOPPED_PTY_DETAIL_SEPARATOR}${detail}`
}

/**
 * Words a sweep that never produced a per-PTY verdict — a wedged daemon, a dropped SSH
 * channel — as the unstopped-PTY failure it is.
 *
 * Why (#11960): this rejection carried only the provider's own wording, which the force
 * classifier cannot recognise, so the wedge the escape hatch exists for was the one case
 * that never got offered it. The provider's message stays in the text; only the shape changes.
 */
export function describeFailedPtySweep(worktreeId: string, error: unknown): string {
  return `${UNSTOPPED_PTY_REMOVAL_PREFIX} ${worktreeId}${UNSTOPPED_PTY_DETAIL_SEPARATOR}the terminal sweep failed: ${describeError(error)}`
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
