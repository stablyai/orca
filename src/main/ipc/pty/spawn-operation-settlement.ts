import type { RetainedTerminalAttempt } from '../../runtime/terminal/launch/retained-terminal-attempt'
import type { PtySpawnOperationState } from './spawn-operation-state'
import type { PtySpawnOutcome } from './spawn-outcome'
import { classifyPreparedSpawnFailure } from './spawn-failure-settlement'

export function settlePreparedSpawnOutcome(
  ctx: PtySpawnOperationState,
  outcome: PtySpawnOutcome,
  attempt: RetainedTerminalAttempt | null,
  adapter: {
    releasePreparation?: () => void
    releaseHiddenMark?: () => void
    onOutcome?: (outcome: PtySpawnOutcome) => void
  }
) {
  let settlementError: unknown
  try {
    settlementError =
      ctx.args.onPreparedSpawnSettlement?.({ kind: 'outcome', outcome }) ??
      attempt?.completed(outcome)
  } finally {
    attempt?.finalized()
  }
  if (outcome.kind === 'registration-exited' && settlementError !== undefined) {
    outcome.settlementError = settlementError
  }
  ctx.paneSpawnOperation?.acquisition?.settle(outcome)
  if (outcome.kind === 'registration-exited') {
    adapter.releasePreparation?.()
    adapter.releaseHiddenMark?.()
  }
  adapter.onOutcome?.(outcome)
  return outcome
}

export function settlePreparedSpawnFailure(
  ctx: PtySpawnOperationState,
  failure: unknown,
  attempt: RetainedTerminalAttempt | null,
  preparedSettled: boolean
) {
  const kind = classifyPreparedSpawnFailure(ctx, failure)
  let error = failure
  try {
    if (!preparedSettled) {
      const presented = ctx.args.onPreparedSpawnSettlement?.({ kind, error: failure }) ?? failure
      error = kind === 'rejected' ? (attempt?.failed(presented) ?? presented) : presented
    }
  } finally {
    attempt?.finalized()
  }
  return { kind, error }
}
