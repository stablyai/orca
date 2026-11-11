import {
  DaemonConnectionLostError,
  DaemonRequestTimeoutError,
  TerminalHostGoneError
} from '../../daemon/protocol/daemon-errors'
import { PaneOwnerContentionError } from './pane/pane-spawn-operation'
import type { PaneSpawnOperation } from './pane/pane-spawn-operation'
import { paneSpawnReservationsByOwnerKey } from './pane/spawn-reservation'
import type { PtySpawnOperationState } from './spawn-operation-state'

export function cancelRegistration(ctx: PtySpawnOperationState): void {
  if (ctx.pendingRegistrationPtyId) {
    ctx.deps.runtime?.cancelPendingPtyRegistration?.(
      ctx.pendingRegistrationPtyId,
      ctx.rejectedRegistrationCandidate?.incarnationId,
      ctx.pendingRegistrationClaim
    )
    ctx.pendingRegistrationPtyId = null
  }
}

export function classifyPreparedSpawnFailure(
  ctx: PtySpawnOperationState,
  failure: unknown
): 'superseded' | 'unknown' | 'rejected' {
  return classifyPaneSpawnFailure(
    ctx.paneSpawnOperation?.acquisition,
    failure,
    Boolean(ctx.stablePaneBindingPersisted || ctx.result.id)
  )
}

export function classifyPaneSpawnFailure(
  acquisition:
    | Pick<NonNullable<PaneSpawnOperation['acquisition']>, 'key' | 'reservation'>
    | undefined,
  failure: unknown,
  materialized = false
): 'superseded' | 'unknown' | 'rejected' {
  const ownsReservation =
    acquisition && paneSpawnReservationsByOwnerKey.get(acquisition.key) === acquisition.reservation
  return failure instanceof PaneOwnerContentionError || (acquisition && !ownsReservation)
    ? 'superseded'
    : materialized || isUnknownSpawnFailure(failure)
      ? 'unknown'
      : 'rejected'
}

export function isUnknownSpawnFailure(error: unknown): boolean {
  const seen = new Set<unknown>()
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error)
    if (
      error instanceof DaemonConnectionLostError ||
      error instanceof DaemonRequestTimeoutError ||
      error instanceof TerminalHostGoneError ||
      ('agentSessionOperationOutcome' in error && error.agentSessionOperationOutcome === 'unknown')
    ) {
      return true
    }
    error = error.cause
  }
  return false
}
