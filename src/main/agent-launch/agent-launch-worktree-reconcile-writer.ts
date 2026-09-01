// The event-driven WRITER half of U4/U5 reconciliation. The pure decision lives
// in agent-launch-reconciliation.ts; this module takes a resolved liveness for a
// pending launch snapshot and persists the mapped outcome through injected
// callbacks, enforcing the plan's coexistence rule for the unknown state:
//   launched               → settle the boundary registered, record `launched`,
//                            clear pending (public + private), clear the failure.
//   invalid_launch_snapshot → write the durable failure ONLY, like unknown: the
//                            pending, the private snapshot/token, and the held
//                            reservation all survive while the conflicting
//                            terminal is live, so its later exit re-derives this
//                            same pending as spawn_failed and Retry re-opens.
//                            NEVER tears down the live-but-unattributed terminal
//                            (the retry gate blocks Retry while it lives).
//   spawn_failed           → record a durable failure, settle failed, clear
//                            pending; Retry becomes available.
//   launch_state_unknown   → write the durable failure ONLY. The public pending,
//                            the private snapshot/token, and the held admission
//                            reservation ALL survive until a live/absent proof or
//                            an explicit Forget releases them (never settled here).
// Electron-free and injectable; the runtime supplies liveness + persistence.

import type {
  AgentLaunchFailure,
  AgentLaunchFailureCode,
  AgentLaunchIntentKind,
  PersistedAgentLaunchFailure
} from '../../shared/agent-launch-contract'
import type {
  AgentLaunchOperationStore,
  PendingAgentLaunchSnapshot
} from './agent-launch-operation-store'
import {
  reconcileAgentLaunchLiveness,
  type AgentLaunchReconcileOutcome,
  type ProviderLiveness
} from './agent-launch-reconciliation'

/** Liveness the runtime resolves for one pending launch token against its own
 *  live terminal view. `attributed` is whether a token-matched live terminal
 *  still belongs to the launch's scope; `terminalId` names it for the ledger. */
export type ResolvedLaunchLiveness =
  | { kind: 'live'; attributed: boolean; terminalId: string }
  | { kind: 'absent' }
  | { kind: 'unknown' }

/** Per-scope durable writes the reconciler drives. `settleLaunched`/`settleFailed`
 *  clear the public pending; `markUnknown` MUST retain it (coexistence rule). It
 *  receives BOTH non-settling codes — launch_state_unknown and
 *  invalid_launch_snapshot — and should keep any existing launch_state_unknown
 *  failureId stable across idempotent re-runs so the client's expectedFailureId
 *  guard does not churn (invalid_launch_snapshot may rotate: Retry is blocked
 *  while the conflicting terminal lives, so no guard reads it). */
export type ReconcileScopePersistence = {
  settleLaunched: () => void
  settleFailed: (failure: PersistedAgentLaunchFailure) => void
  markUnknown: (failure: PersistedAgentLaunchFailure) => void
}

export type ReconcileAgentLaunchDeps = {
  operationStore: AgentLaunchOperationStore
  resolveLiveness: (pending: PendingAgentLaunchSnapshot) => ResolvedLaunchLiveness
  // Routes on the pending's INTENT (not just its scope string) so background,
  // automation, orchestration, and worktree launches land in their own owner
  // record even when two owners happen to share a scope id namespace.
  persistenceFor: (pending: PendingAgentLaunchSnapshot) => ReconcileScopePersistence
  settleBoundary: (launchToken: string, settlement: 'registered' | 'failed') => void
  mintFailureId: () => string
  now?: () => number
}

function toProviderLiveness(liveness: ResolvedLaunchLiveness): ProviderLiveness {
  return liveness.kind === 'live'
    ? { kind: 'live', attributed: liveness.attributed }
    : { kind: liveness.kind }
}

function persistedFailure(
  code: AgentLaunchFailureCode,
  pending: PendingAgentLaunchSnapshot,
  deps: ReconcileAgentLaunchDeps,
  intent: AgentLaunchIntentKind,
  occurredAt: number
): PersistedAgentLaunchFailure {
  const failure: AgentLaunchFailure = {
    code,
    requestedAgent: pending.snapshot.requestedAgent,
    baseAgent: pending.snapshot.baseAgent
  }
  return { ...failure, version: 1, failureId: deps.mintFailureId(), intent, occurredAt }
}

/** Reconcile ONE pending launch snapshot against resolved liveness and persist
 *  the mapped outcome. Idempotent: a snapshot a concurrent transaction/forget
 *  already settled is skipped. Returns the applied outcome, or null if skipped. */
export function reconcileOnePendingAgentLaunch(
  deps: ReconcileAgentLaunchDeps,
  pending: PendingAgentLaunchSnapshot
): AgentLaunchReconcileOutcome | null {
  const nowFn = deps.now ?? Date.now
  // Re-read: a concurrent transaction/forget may have settled this token first.
  if (!deps.operationStore.getPending(pending.launchToken)) {
    return null
  }
  // The spawn transaction still owns this token; reconciliation must not race
  // it into a false absent/spawn-failed settlement.
  if (deps.operationStore.isSpawnInFlight(pending.launchToken)) {
    return null
  }
  const liveness = deps.resolveLiveness(pending)
  const outcome = reconcileAgentLaunchLiveness(toProviderLiveness(liveness))
  const persistence = deps.persistenceFor(pending)
  const liveTerminalId = liveness.kind === 'live' ? liveness.terminalId : null

  if (outcome.kind === 'launched') {
    deps.settleBoundary(pending.launchToken, 'registered')
    // Settled entry + pending drop in one atomic durable write; a crash leaves
    // one of the two, and either alone reconciles/replays.
    deps.operationStore.settleAndClearPending(
      {
        operationId: pending.operationId,
        idempotencyKey: pending.idempotencyKey,
        scope: pending.scope,
        payloadDigest: pending.payloadDigest,
        status: 'launched',
        terminalId: liveTerminalId,
        failureId: null,
        settledAt: nowFn()
      },
      pending.launchToken
    )
    persistence.settleLaunched()
    return outcome
  }

  if (outcome.kind === 'spawn_failed') {
    const failure = persistedFailure(outcome.kind, pending, deps, pending.intent, nowFn())
    deps.settleBoundary(pending.launchToken, 'failed')
    deps.operationStore.settleAndClearPending(
      {
        operationId: pending.operationId,
        idempotencyKey: pending.idempotencyKey,
        scope: pending.scope,
        payloadDigest: pending.payloadDigest,
        status: 'failed',
        terminalId: liveTerminalId,
        failureId: failure.failureId,
        settledAt: nowFn()
      },
      pending.launchToken
    )
    persistence.settleFailed(failure)
    return outcome
  }

  // invalid_launch_snapshot / launch_state_unknown — coexistence rule: settle
  // nothing, clear nothing, release nothing. Only the durable failure card is
  // (re)written. Retaining the pending is what re-opens recovery later: once
  // the conflicting (or unreachable) terminal is gone, the next liveness event
  // reconciles this same pending as spawn_failed (retryable) — never a
  // permanent dead-end that neither Retry nor Forget can clear.
  const failure = persistedFailure(outcome.kind, pending, deps, pending.intent, nowFn())
  persistence.markUnknown(failure)
  return outcome
}

/** Run reconciliation across every pending snapshot (optionally filtered to a
 *  scope/provider). Snapshot the list first so per-entry clears do not disturb
 *  iteration. */
export function reconcileAllPendingAgentLaunches(
  deps: ReconcileAgentLaunchDeps,
  filter?: (pending: PendingAgentLaunchSnapshot) => boolean
): void {
  for (const pending of deps.operationStore.pendingSnapshots()) {
    if (!filter || filter(pending)) {
      reconcileOnePendingAgentLaunch(deps, pending)
    }
  }
}
