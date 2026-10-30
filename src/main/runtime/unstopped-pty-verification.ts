import type { IPtyProvider } from '../providers/pty-provider-contract'
import type { OrcaRuntimeService } from './orca-runtime'

type UnstoppedPtyRuntime = Pick<OrcaRuntimeService, 'getPtyLivenessVerdict'>
import {
  UNSTOPPED_PTY_DETAIL_SEPARATOR,
  STILL_LIVE_DETAIL_PREFIX,
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

/** Give post-stop verification its own budget; the spent sweep deadline falsely timed out reachable inventories and blocked removal (#11960). Preserve live/exited/unverifiable distinctions. */
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
        return await provider.listProcesses({ deadlineMs: verifyDeadline, ptyIds: failedPtyIds })
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

/** Unreachable owning hosts remain unverifiable; another provider's silence cannot certify their exits. Force Delete remains available. */
export function unverifiableStopVerdict(
  failedPtyIds: readonly string[],
  runtime: UnstoppedPtyRuntime | undefined
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
  runtime?: UnstoppedPtyRuntime
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
      ? `${STILL_LIVE_DETAIL_PREFIX} ${verdict.ptyIds.join(', ')}`
      : `could not verify these exited: ${failedPtyIds.join(', ')} (${verdict.reason})`
  return `${UNSTOPPED_PTY_REMOVAL_PREFIX} ${worktreeId}${UNSTOPPED_PTY_DETAIL_SEPARATOR}${detail}`
}

/** Keep the provider error inside the recognizable unstopped-PTY shape so the force-removal escape hatch is offered (#11960). */
export function describeFailedPtySweep(worktreeId: string, error: unknown): string {
  return `${UNSTOPPED_PTY_REMOVAL_PREFIX} ${worktreeId}${UNSTOPPED_PTY_DETAIL_SEPARATOR}the terminal sweep failed: ${describeError(error)}`
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
