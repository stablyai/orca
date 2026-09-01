// Host orchestration for `worktree.retryAgentLaunch` (U4). A retry is a fresh
// two-stage launch against an EXISTING worktree, guarded by four ordered checks
// the plan requires and applied here in this exact order:
//   1. Payload-scoped idempotency FIRST — a settled-ledger hit replays the prior
//      result, an in-flight hit joins its promise, and a key reuse with a
//      DIFFERENT payload returns idempotency_conflict. Ordering it first means a
//      double-click after a successful retry replays `launched` instead of
//      tripping the (now-cleared) failure guard below.
//   2. `expectedFailureId` anti-race guard against the current durable failure;
//      a mismatch (or a cleared/rotated failure) returns stale_agent_launch_failure.
//   3. Server-side recovery-card gating that mirrors the exact state the card
//      renders (launch_state_unknown / invalid_launch_snapshot) and blocks WITHOUT
//      mutation, so the rejection code always matches the visible card state.
//   4. Only then resolve the action into a launch request and run the shared
//      create transaction (which reserves capacity, re-resolves, and settles).
// `expectedFailureId` is an anti-race guard shown in client metadata, never an
// authorization secret. Electron-free and fully injection-based.

import type { PersistedAgentLaunchFailure } from '../../shared/agent-launch-contract'
import type { AgentLaunchSpawnRequest } from '../../shared/agent-launch-spawn-request'
import {
  canonicalPayloadDigest,
  type AgentLaunchOperationStore,
  type SettledAgentLaunchOperation
} from './agent-launch-operation-store'

// The client-safe retry action and tri-state result live in shared so renderer,
// preload, and this host orchestrator type-check against one definition.
export type {
  RetryAgentLaunchAction,
  WorktreeRetryAgentLaunchResult
} from '../../shared/agent-launch-worktree-recovery'
import type {
  RetryAgentLaunchAction,
  WorktreeRetryAgentLaunchResult
} from '../../shared/agent-launch-worktree-recovery'

export type WorktreeRetryAgentLaunchParams = {
  /** Owner bucket for the op-store ledger/idempotency joins: worktree id for an
   *  interactive launch, attempt id for a generic background attempt. */
  scope: string
  expectedFailureId: string
  // Already validated to canonical lowercase UUID form by the RPC schema.
  clientMutationId: string
  action: RetryAgentLaunchAction
}

/** Current recovery state derived from tri-state reconciliation. `retryable`
 *  means the durable failure is settled and no live terminal contradicts it. */
export type RetryRecoveryGate =
  | { kind: 'retryable' }
  | { kind: 'launch_state_unknown' }
  | { kind: 'invalid_launch_snapshot' }

export type WorktreeRetryInFlight = {
  payloadDigest: string
  promise: Promise<WorktreeRetryAgentLaunchResult>
}

export type WorktreeRetryAgentLaunchDeps = {
  operationStore: AgentLaunchOperationStore
  /** Idempotency scope key = stable authenticated principal + worktree +
   *  clientMutationId; survives host restart and client reconnect. */
  idempotencyKeyFor: (clientMutationId: string) => string
  /** Ephemeral cross-connection in-flight join; null when none is running. */
  findInFlight: (idempotencyKey: string) => WorktreeRetryInFlight | null
  /** Register the launch promise for concurrent joins; the implementation clears
   *  it when the promise settles. Must be synchronous (no await before it) so the
   *  find/register pair is atomic against a concurrent double-click. */
  registerInFlight: (
    idempotencyKey: string,
    payloadDigest: string,
    promise: Promise<WorktreeRetryAgentLaunchResult>
  ) => void
  /** Map an evicted-or-current settled ledger entry to the authorized receipt or
   *  durable failure it references. */
  resolveSettled: (settled: SettledAgentLaunchOperation) => WorktreeRetryAgentLaunchResult
  /** The current durable failure on the worktree, or null when cleared. */
  loadDurableFailure: () => PersistedAgentLaunchFailure | null
  /** Server-side recovery-card gate from tri-state reconciliation. */
  resolveRecoveryGate: () => RetryRecoveryGate
  /** Run the shared reserve -> execute -> spawn -> settle launch for the resolved
   *  request; mirrors create's finish and owns prepare-failure classification
   *  (capacity/deterministic -> blocked, request errors -> rejected). */
  runLaunch: (input: {
    request: AgentLaunchSpawnRequest
    idempotencyKey: string
    clientMutationId: string
    payloadDigest: string
    priorFailureId: string
  }) => Promise<WorktreeRetryAgentLaunchResult>
}

/** Canonical payload for the idempotency digest: the action alone identifies the
 *  request (retry-same is nullary; change-agent carries its target identity). */
function canonicalizeAction(action: RetryAgentLaunchAction): unknown {
  return action.kind === 'change-agent'
    ? { kind: 'change-agent', agent: action.agent }
    : { kind: 'retry-same' }
}

/** Build the launch request from the action. retry-same loads the identity from
 *  the durable failure and gets persisted-reference authority (a saved
 *  `workspace` owner, so tombstone/safe-fallback resolution is allowed);
 *  change-agent is a live selection with NO sourceRecord, so it must resolve a
 *  currently-existing enabled agent and never gains fallback authority. */
function buildRetryRequest(
  action: RetryAgentLaunchAction,
  failure: PersistedAgentLaunchFailure
): AgentLaunchSpawnRequest {
  if (action.kind === 'change-agent') {
    return { selection: { kind: 'agent', agent: action.agent }, allowEmptyPromptLaunch: true }
  }
  if (failure.requestedAgent) {
    return {
      selection: { kind: 'agent', agent: failure.requestedAgent },
      allowEmptyPromptLaunch: true,
      sourceRecord: { owner: 'workspace' }
    }
  }
  // A failure with no pinned identity (e.g. no_agent_selected) retries the host
  // default, which already carries persisted/default authority.
  return { selection: { kind: 'default' }, allowEmptyPromptLaunch: true }
}

export async function runWorktreeRetryAgentLaunch(
  deps: WorktreeRetryAgentLaunchDeps,
  params: WorktreeRetryAgentLaunchParams
): Promise<WorktreeRetryAgentLaunchResult> {
  const idempotencyKey = deps.idempotencyKeyFor(params.clientMutationId)
  const payloadDigest = canonicalPayloadDigest(canonicalizeAction(params.action))

  // 1. Idempotency — settled ledger, then in-flight. Same key + different payload
  // is a conflict; same key + same payload replays/joins without a second launch.
  const settled = deps.operationStore.findSettledByIdempotencyKey(params.scope, idempotencyKey)
  if (settled) {
    return settled.payloadDigest === payloadDigest
      ? deps.resolveSettled(settled)
      : { status: 'rejected', requestError: { code: 'idempotency_conflict' } }
  }
  const inFlight = deps.findInFlight(idempotencyKey)
  if (inFlight) {
    return inFlight.payloadDigest === payloadDigest
      ? inFlight.promise
      : { status: 'rejected', requestError: { code: 'idempotency_conflict' } }
  }

  // 2. expectedFailureId guard against the current durable failure. A cleared or
  // rotated failure fails here rather than becoming a new launch.
  const failure = deps.loadDurableFailure()
  if (!failure || failure.failureId !== params.expectedFailureId) {
    return { status: 'rejected', requestError: { code: 'stale_agent_launch_failure' } }
  }

  // 3. Recovery-card gate — block WITHOUT mutation so the rejection code matches
  // the exact state the card renders.
  const gate = deps.resolveRecoveryGate()
  if (gate.kind !== 'retryable') {
    return { status: 'blocked', failure: { code: gate.kind } }
  }

  // 4. Resolve the action and run the shared launch. Register the promise before
  // returning (no await in between) so a concurrent duplicate joins it.
  const request = buildRetryRequest(params.action, failure)
  const promise = deps.runLaunch({
    request,
    idempotencyKey,
    clientMutationId: params.clientMutationId,
    payloadDigest,
    priorFailureId: params.expectedFailureId
  })
  deps.registerInFlight(idempotencyKey, payloadDigest, promise)
  return promise
}
