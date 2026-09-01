// The created-path transaction for a worktree `agentLaunch` (U4). Given the
// stage-2 resolution thunk (executeWorktreeAgentLaunch) and injected persistence/
// spawn callbacks, it enforces the plan's ordering guarantees exactly:
//   1. resolve+admit (the thunk) — a failure released the reservation already;
//   2. persist the public pending metadata AND the private snapshot/token in ONE
//      synchronous write BEFORE the writer, so a crash mid-spawn still self-
//      identifies the terminal by token;
//   3. spawn exactly ONE PTY from the resolved plan (token travels inside it);
//   4. settle — registered clears pending + records `launched`; a host-attested
//      post-create failure keeps the workspace, writes a durable
//      `agentLaunchFailure`, and records `failed`. Loss of contact mid-spawn is
//      NOT attested (the host may have spawned the agent): it keeps the pending
//      and reservation, and writes launch_state_unknown instead of settling.
//      No path spawns a substitute blank terminal (I9).
// A request error performs no owner-state write. Electron-free and injectable.

import type { AgentStartupPlan } from '../../shared/tui-agent-startup'
import type {
  AgentLaunchFailure,
  AgentLaunchIntentKind,
  AgentLaunchReceipt,
  AgentLaunchRequestError,
  PersistedAgentLaunchFailure
} from '../../shared/agent-launch-contract'
import { isSpawnContactLossError } from './agent-launch-spawn-contact-loss'
import type { TuiAgent } from '../../shared/types'
import type { AgentLaunchBoundary, ExecuteAgentLaunchResult } from './agent-launch-boundary'
import type { AdmissionPrincipal } from './agent-launch-admission-store'
import type { AgentLaunchOperationStore } from './agent-launch-operation-store'

/** Public pending metadata the caller writes onto WorktreeMeta. The private
 *  snapshot/token stay in the operation store and never enter this shape. */
export type WorktreePendingAgentLaunch = {
  operationId: string
  requestedAgent: TuiAgent
  priorFailureId?: string
}

/** Creates and registers exactly ONE PTY from the resolved plan. The receipt
 *  carries the launch token (which travels inside the spawn request) plus the
 *  built-in base agent the terminal binds for process/telemetry keying. Must
 *  throw on spawn/registration failure so the reservation settles `failed`; a
 *  returned value means the PTY is registered and names the terminal id. */
export type WorktreeLaunchSpawn = (
  plan: AgentStartupPlan,
  receipt: AgentLaunchReceipt
) => Promise<{ terminalId: string }>

export type WorktreeAgentLaunchTransactionDeps = {
  boundary: AgentLaunchBoundary
  operationStore: AgentLaunchOperationStore
  /** Public pending metadata write; paired with the private snapshot write in
   *  the same synchronous transaction, before the writer. */
  persistPending: (pending: WorktreePendingAgentLaunch) => void
  spawn: WorktreeLaunchSpawn
  /** Clear the public pending metadata after a registered launch. */
  clearPublicPending: () => void
  /** Persist the durable failure onto WorktreeMeta.agentLaunchFailure and clear
   *  any pending metadata. Must be safe to call whether or not pending was
   *  written (execute-stage vs spawn-stage failure). */
  persistFailure: (failure: PersistedAgentLaunchFailure) => void
  mintFailureId: () => string
  now?: () => number
}

export type WorktreeAgentLaunchTransactionParams = {
  operationId: string
  idempotencyKey: string
  scope: string
  payloadDigest: string
  clientMutationId: string | null
  requestedAgent: TuiAgent
  intent: AgentLaunchIntentKind
  /** Admission principal holding the reservation, persisted into the pending
   *  snapshot so a restart rebuilds capacity counters into the right bucket. */
  principal: AdmissionPrincipal
  priorFailureId?: string
  /** Stage-2 resolution: re-resolve with authoritative paths + pinned identity,
   *  recheck the digest, and convert the held reservation. Releases the
   *  reservation itself on any failure. */
  execute: () => Promise<ExecuteAgentLaunchResult>
}

export type WorktreeAgentLaunchOutcome =
  | { status: 'launched'; receipt: AgentLaunchReceipt; terminalId: string }
  | { status: 'failed'; failure: PersistedAgentLaunchFailure }
  | { status: 'request_error'; requestError: AgentLaunchRequestError }

function persistedFailure(
  deps: WorktreeAgentLaunchTransactionDeps,
  params: WorktreeAgentLaunchTransactionParams,
  failure: AgentLaunchFailure,
  nowFn: () => number,
  // When set, the settled entry and the pending drop land in ONE durable write.
  clearPendingLaunchToken?: string
): { status: 'failed'; failure: PersistedAgentLaunchFailure } {
  const persisted: PersistedAgentLaunchFailure = {
    ...failure,
    version: 1,
    failureId: deps.mintFailureId(),
    intent: params.intent,
    occurredAt: nowFn()
  }
  // Keep the workspace; the durable failure card offers Retry/Choose agent.
  deps.persistFailure(persisted)
  const settled = {
    operationId: params.operationId,
    idempotencyKey: params.idempotencyKey,
    scope: params.scope,
    payloadDigest: params.payloadDigest,
    status: 'failed' as const,
    terminalId: null,
    failureId: persisted.failureId,
    settledAt: nowFn()
  }
  if (clearPendingLaunchToken) {
    deps.operationStore.settleAndClearPending(settled, clearPendingLaunchToken)
  } else {
    deps.operationStore.recordSettled(settled)
  }
  return { status: 'failed', failure: persisted }
}

/** Run the created-path transaction. The git worktree already exists; a failure
 *  here NEVER rolls it back and NEVER spawns a substitute shell. */
export async function runWorktreeAgentLaunchTransaction(
  deps: WorktreeAgentLaunchTransactionDeps,
  params: WorktreeAgentLaunchTransactionParams
): Promise<WorktreeAgentLaunchOutcome> {
  const nowFn = deps.now ?? Date.now
  const execution = await params.execute()
  if (!execution.ok) {
    if ('requestError' in execution) {
      // Request errors perform no owner-state write; the reservation is already
      // released by execute.
      return { status: 'request_error', requestError: execution.requestError }
    }
    return persistedFailure(deps, params, execution.failure, nowFn)
  }
  const { plan, receipt } = execution
  const snapshot = deps.boundary.pendingSnapshotFor(receipt.launchToken)
  if (!snapshot) {
    // The admitted token must carry a private snapshot; a missing one cannot be
    // attributed, so fail closed rather than spawn an unattributable terminal.
    deps.boundary.settleAgentLaunch(receipt.launchToken, 'failed')
    return persistedFailure(
      deps,
      params,
      {
        code: 'invalid_launch_snapshot',
        requestedAgent: receipt.requestedAgent,
        baseAgent: receipt.baseAgent
      },
      nowFn
    )
  }

  // ONE persistence transaction before the writer: private snapshot/token first,
  // then the client-safe pending metadata. Both synchronous so no mutation lands
  // between them and a mid-spawn crash still resolves via the persisted token.
  try {
    deps.operationStore.beginPending({
      operationId: params.operationId,
      idempotencyKey: params.idempotencyKey,
      scope: params.scope,
      clientMutationId: params.clientMutationId,
      payloadDigest: params.payloadDigest,
      launchToken: receipt.launchToken,
      intent: params.intent,
      principal: params.principal,
      snapshot
    })
    deps.persistPending({
      operationId: params.operationId,
      requestedAgent: receipt.requestedAgent,
      ...(params.priorFailureId ? { priorFailureId: params.priorFailureId } : {})
    })
  } catch {
    // A throwing store write must RELEASE the admitted launch, never strand it
    // pending forever; clearPending in `finally` drops a half-written snapshot
    // even if the failure write itself throws too.
    deps.boundary.settleAgentLaunch(receipt.launchToken, 'failed')
    try {
      return persistedFailure(
        deps,
        params,
        {
          code: 'spawn_failed',
          requestedAgent: receipt.requestedAgent,
          baseAgent: receipt.baseAgent
        },
        nowFn
      )
    } finally {
      deps.operationStore.clearPending(receipt.launchToken)
    }
  }

  let terminalId: string
  try {
    const spawned = await deps.spawn(plan, receipt)
    terminalId = spawned.terminalId
  } catch (error) {
    if (isSpawnContactLossError(error)) {
      // Contact with the execution host broke while the spawn was (possibly) in
      // flight — the host may well have spawned the agent (ssh-execution-boundary:
      // a transport failure can only ever produce `unverifiable`). Settling
      // `failed` here would clear the pending and hand the user a plain Retry
      // that cold-starts a duplicate beside a live remote agent. Instead: keep
      // the private pending + admission reservation (coexistence rule, exactly
      // like a reconciled launch_state_unknown), release only the in-flight
      // guard so provider-reconnect reconciliation may settle this token on real
      // host evidence, and persist the non-retryable launch_state_unknown card
      // (the server-side retry gate blocks on this code; the client card offers
      // reconnect/forget, never plain Retry). No settled ledger entry: the
      // operation has NOT settled.
      deps.operationStore.releaseSpawnInFlight(receipt.launchToken)
      const failure: PersistedAgentLaunchFailure = {
        code: 'launch_state_unknown',
        requestedAgent: receipt.requestedAgent,
        baseAgent: receipt.baseAgent,
        version: 1,
        failureId: deps.mintFailureId(),
        intent: params.intent,
        occurredAt: nowFn()
      }
      // persistFailure also clears the public pending metadata; the durable card
      // replaces it client-side while the private snapshot retains attribution.
      deps.persistFailure(failure)
      return { status: 'failed', failure }
    }
    deps.boundary.settleAgentLaunch(receipt.launchToken, 'failed')
    // Settled entry + pending drop in one atomic durable write: a crash before
    // it leaves the pending attribution, after it the settled entry — either
    // alone reconciles/replays.
    return persistedFailure(
      deps,
      params,
      {
        code: 'spawn_failed',
        requestedAgent: receipt.requestedAgent,
        baseAgent: receipt.baseAgent
      },
      nowFn,
      receipt.launchToken
    )
  }

  // Registered: move attribution into the boundary's retained handoff, then
  // append the settled `launched` entry and clear the private pending in ONE
  // atomic durable write — a crash leaves either the pending or the settled
  // entry, and each alone reconciles/replays (recordSettled replay is
  // idempotent).
  deps.boundary.settleAgentLaunch(receipt.launchToken, 'registered')
  deps.operationStore.settleAndClearPending(
    {
      operationId: params.operationId,
      idempotencyKey: params.idempotencyKey,
      scope: params.scope,
      payloadDigest: params.payloadDigest,
      status: 'launched',
      terminalId,
      failureId: null,
      settledAt: nowFn()
    },
    receipt.launchToken
  )
  deps.clearPublicPending()
  return { status: 'launched', receipt, terminalId }
}
