// Pure tri-state reconciliation for a pending agent launch (U4/U5). The provider
// reports one of three liveness results for a launch token — live, absent, or
// unknown — and this maps them to the four persisted recovery outcomes in the
// plan's table. It NEVER polls or sleeps: provider reconnect / terminal-list
// events rerun it. Absence is authoritative only for providers whose terminals
// die with main (local in-process PTYs); daemon/SSH/WSL-relay/remote-runtime
// terminals may outlive main, so their `absent` must come from a real provider
// listing, and a disconnected provider is `unknown`, never a false `absent` that
// would enable a duplicate retry. Electron-free and injectable.

import type { AgentLaunchFailureCode } from '../../shared/agent-launch-contract'
import type { RetryRecoveryGate } from './agent-launch-worktree-retry'

/** Provider liveness for a launch token. `attributed` is whether the live
 *  terminal still carries a matching private snapshot/token attribution; a
 *  token-matched terminal without it cannot be trusted as the launched agent. */
export type ProviderLiveness =
  | { kind: 'live'; attributed: boolean }
  | { kind: 'absent' }
  | { kind: 'unknown' }

/** Reconciled outcome, one per row of the plan's reconciliation table. */
export type AgentLaunchReconcileOutcome =
  // Settle launched, clear pending/failure, never spawn again.
  | { kind: 'launched' }
  // Token-live but unattributed: write the invalid_launch_snapshot failure but
  // KEEP pending (coexistence, like unknown), keep the terminal visible, disable
  // Retry/Choose while live, never spawn a duplicate. The retained pending lets
  // the terminal's later exit re-reconcile to spawn_failed, re-opening Retry.
  | { kind: 'invalid_launch_snapshot' }
  // Absent: settle failed/spawn_failed; Retry becomes available.
  | { kind: 'spawn_failed' }
  // Unknown: keep pending, show "Launch state unavailable", spawn/tear down nothing.
  | { kind: 'launch_state_unknown' }

export function reconcileAgentLaunchLiveness(
  liveness: ProviderLiveness
): AgentLaunchReconcileOutcome {
  switch (liveness.kind) {
    case 'live':
      return liveness.attributed ? { kind: 'launched' } : { kind: 'invalid_launch_snapshot' }
    case 'absent':
      return { kind: 'spawn_failed' }
    case 'unknown':
      return { kind: 'launch_state_unknown' }
  }
}

/** Retry recovery gate derived from the CURRENT persisted failure code, not a
 *  live probe: reconciliation is event-driven and has already written the code
 *  the recovery card renders, so the server-side gate reads that same state. The
 *  two blocking codes (launch_state_unknown while liveness is unknown,
 *  invalid_launch_snapshot while a token-live terminal lacks attribution) fail
 *  the retry WITHOUT mutation; every other durable failure is retryable. Neither
 *  block is permanent: both codes keep their pending (coexistence rule), so the
 *  next liveness event rewrites the code — absent proof yields spawn_failed and
 *  this same gate turns retryable. */
export function retryRecoveryGateForFailureCode(
  code: AgentLaunchFailureCode | undefined
): RetryRecoveryGate {
  if (code === 'launch_state_unknown') {
    return { kind: 'launch_state_unknown' }
  }
  if (code === 'invalid_launch_snapshot') {
    return { kind: 'invalid_launch_snapshot' }
  }
  return { kind: 'retryable' }
}
