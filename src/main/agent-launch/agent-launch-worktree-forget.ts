// Pure orchestrator for `forgetUnknownAgentLaunch` (U4/U5). An authorized owner
// explicitly forgets a launch stranded in `launch_state_unknown` when Orca cannot
// reach the terminal host. Forgetting NEVER kills or spawns anything (the remote
// process may still be running); it only releases Orca's local bookkeeping:
//   - settles the public attempt as `forgotten` in the idempotency ledger,
//   - removes the private pending snapshot/token attribution,
//   - frees the held admission reservation (capacity),
//   - clears the public pending metadata and the unknown failure card.
// Guards, in order: idempotency replay first (a double-submit after a successful
// forget replays `forgotten` instead of hitting the now-empty pending), then the
// operation-id anti-race guard, then the caller-principal owner check, then the
// "only from matching launch_state_unknown" gate. `expectedOperationId` is an
// anti-race guard, never authorization — `callerPrincipal` is the authorization.
// Electron-free and injectable.

import type {
  AgentLaunchFailureCode,
  AgentLaunchRequestError
} from '../../shared/agent-launch-contract'
import { admissionPrincipalOwns, type AdmissionPrincipal } from './agent-launch-admission-store'
import {
  canonicalPayloadDigest,
  type AgentLaunchOperationStore,
  type PendingAgentLaunchSnapshot,
  type SettledAgentLaunchOperation
} from './agent-launch-operation-store'

export type ForgetUnknownAgentLaunchParams = {
  /** Owner bucket for the op-store ledger/pending lookup: worktree id for an
   *  interactive launch, attempt id for a generic background attempt. */
  scope: string
  expectedOperationId: string
  clientMutationId: string
  /** The authenticated caller. When present, the launch's stored admission
   *  principal must belong to it, so one paired device cannot forget another
   *  device's launch. Omitted only by host-internal overrides that carry their
   *  own gate (the revoked-remote forget). */
  callerPrincipal?: AdmissionPrincipal
}

// The client-safe forget result lives in shared so renderer, preload, and this
// host orchestrator type-check against one definition.
export type { ForgetUnknownAgentLaunchResult } from '../../shared/agent-launch-worktree-recovery'
import type { ForgetUnknownAgentLaunchResult } from '../../shared/agent-launch-worktree-recovery'

export type ForgetUnknownAgentLaunchDeps = {
  operationStore: AgentLaunchOperationStore
  idempotencyKeyFor: (clientMutationId: string) => string
  /** The private pending snapshot for this scope (source of the launch token and
   *  the authoritative operation id), or null once nothing is pending. */
  loadPendingSnapshot: () => PendingAgentLaunchSnapshot | null
  /** The scope's current durable failure code; forget is allowed only when it is
   *  `launch_state_unknown`. */
  loadFailureCode: () => AgentLaunchFailureCode | undefined
  /** Free the held admission reservation for the launch token (capacity). */
  releaseReservation: (launchToken: string) => void
  /** Clear the public pending metadata and the unknown failure card. */
  clearPublicState: () => void
  now?: () => number
}

const FORGET_KIND = 'forget' as const

function rejected(code: AgentLaunchRequestError['code']): ForgetUnknownAgentLaunchResult {
  return { status: 'rejected', requestError: { code } }
}

function resolveSettled(settled: SettledAgentLaunchOperation): ForgetUnknownAgentLaunchResult {
  // Only a forget settles `forgotten`; any other settled status under this key
  // means the mutation id was reused for a different operation.
  return settled.status === 'forgotten' ? { status: 'forgotten' } : rejected('idempotency_conflict')
}

export function runForgetUnknownAgentLaunch(
  deps: ForgetUnknownAgentLaunchDeps,
  params: ForgetUnknownAgentLaunchParams
): ForgetUnknownAgentLaunchResult {
  const nowFn = deps.now ?? Date.now
  const idempotencyKey = deps.idempotencyKeyFor(params.clientMutationId)
  const payloadDigest = canonicalPayloadDigest({
    kind: FORGET_KIND,
    expectedOperationId: params.expectedOperationId
  })

  // 1. Idempotency first: a settled ledger entry replays without re-mutating.
  const settled = deps.operationStore.findSettledByIdempotencyKey(params.scope, idempotencyKey)
  if (settled) {
    return settled.payloadDigest === payloadDigest
      ? resolveSettled(settled)
      : rejected('idempotency_conflict')
  }

  // 2. Operation-id anti-race guard: the private pending must still be present and
  //    name the operation the client believes it is forgetting.
  const pending = deps.loadPendingSnapshot()
  if (!pending || pending.operationId !== params.expectedOperationId) {
    return rejected('stale_agent_launch_failure')
  }

  // 2b. Owner check: the stored admission principal must be the caller's. Same
  //     rejection as a missing pending, so a foreign device learns nothing about
  //     another device's launch. A pre-device-principal row matches any device of
  //     its kind and so stays forgettable.
  if (
    params.callerPrincipal &&
    !admissionPrincipalOwns(params.callerPrincipal, pending.principal)
  ) {
    return rejected('stale_agent_launch_failure')
  }

  // 3. Only a matching launch_state_unknown is forgettable; any other state means
  //    reconciliation already resolved it, so there is nothing stranded to forget.
  if (deps.loadFailureCode() !== 'launch_state_unknown') {
    return rejected('stale_agent_launch_failure')
  }

  // Settle `forgotten` and drop the private attribution in one atomic durable
  // write, then free the reservation. No kill/spawn: a later provider terminal
  // is treated as unattributed.
  deps.operationStore.settleAndClearPending(
    {
      operationId: pending.operationId,
      idempotencyKey,
      scope: params.scope,
      payloadDigest,
      status: 'forgotten',
      terminalId: null,
      failureId: null,
      settledAt: nowFn()
    },
    pending.launchToken
  )
  deps.releaseReservation(pending.launchToken)
  deps.clearPublicState()
  return { status: 'forgotten' }
}
