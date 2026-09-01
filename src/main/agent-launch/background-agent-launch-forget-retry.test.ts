// Injected-attempts integration for the generic background Forget/Retry surface
// (U6, ledger #13). Wires the SAME shared orchestrators the runtime methods use
// (runForgetUnknownAgentLaunch / runWorktreeRetryAgentLaunch) to a real background
// attempt store + operation store, proving the G6 oracles: owner-authorized Forget
// frees exactly one reservation and never spawns/kills; Retry follows the
// persisted-state gating discipline. No production producer is synthesized — every
// attempt here is injected.

import { describe, expect, it, vi } from 'vitest'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import type { PersistedAgentLaunchFailure } from '../../shared/agent-launch-contract'
import type {
  WorktreeRetryAgentLaunchResult,
  WorktreeRetryInFlight
} from './agent-launch-worktree-retry'
import {
  AgentLaunchOperationStore,
  agentLaunchIdempotencyKey,
  type PendingAgentLaunchSnapshot
} from './agent-launch-operation-store'
import { retryRecoveryGateForFailureCode } from './agent-launch-reconciliation'
import { runForgetUnknownAgentLaunch } from './agent-launch-worktree-forget'
import { runWorktreeRetryAgentLaunch } from './agent-launch-worktree-retry'
import { BackgroundAgentLaunchStore } from './background-agent-launch-store'

const ATTEMPT_ID = 'attempt-bg-1'
const WORKTREE_ID = 'repo-1:wt-a'
const OPERATION_ID = 'op-bg-1'
const LAUNCH_TOKEN = 'token-bg-1'
const CLIENT_MUTATION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const FAILURE_ID = 'failure-bg-1'

function snapshot(): AgentLaunchSnapshot {
  return {
    version: 1,
    requestedAgent: 'custom-agent:codex:x',
    baseAgent: 'codex',
    displayLabel: 'Custom',
    mode: 'custom',
    argv: ['codex'],
    agentEnv: {},
    capturedEnvPolicy: 'none',
    target: {
      platform: 'linux',
      execution: 'native',
      shell: 'posix',
      isRemote: true,
      executionHostId: 'ssh:host'
    }
  }
}

function unknownFailure(): PersistedAgentLaunchFailure {
  return {
    code: 'launch_state_unknown',
    requestedAgent: 'custom-agent:codex:x',
    version: 1,
    failureId: FAILURE_ID,
    intent: 'background',
    occurredAt: 1
  }
}

function spawnFailedFailure(): PersistedAgentLaunchFailure {
  return {
    code: 'spawn_failed',
    requestedAgent: 'custom-agent:codex:x',
    baseAgent: 'codex',
    version: 1,
    failureId: FAILURE_ID,
    intent: 'background',
    occurredAt: 1
  }
}

function pending(): PendingAgentLaunchSnapshot {
  return {
    operationId: OPERATION_ID,
    idempotencyKey: agentLaunchIdempotencyKey({
      principal: { kind: 'local' },
      scope: ATTEMPT_ID,
      clientMutationId: CLIENT_MUTATION_ID
    }),
    scope: ATTEMPT_ID,
    clientMutationId: CLIENT_MUTATION_ID,
    payloadDigest: 'digest',
    launchToken: LAUNCH_TOKEN,
    intent: 'background',
    snapshot: snapshot()
  }
}

/** Build the exact forget deps the runtime method wires, over real stores. */
function buildForgetHarness() {
  const opStore = new AgentLaunchOperationStore()
  const bgStore = new BackgroundAgentLaunchStore({ now: () => 5000 })
  bgStore.create({
    attemptId: ATTEMPT_ID,
    worktreeId: WORKTREE_ID,
    operationId: OPERATION_ID,
    requestedAgent: 'custom-agent:codex:x',
    baseAgent: 'codex'
  })
  bgStore.markUnknown(ATTEMPT_ID, unknownFailure())
  opStore.beginPending(pending())
  const releaseReservation = vi.fn<(launchToken: string) => void>()
  return { opStore, bgStore, releaseReservation }
}

function forgetDeps(harness: ReturnType<typeof buildForgetHarness>) {
  const { opStore, bgStore, releaseReservation } = harness
  return {
    operationStore: opStore,
    idempotencyKeyFor: (clientMutationId: string) =>
      agentLaunchIdempotencyKey({
        principal: { kind: 'local' },
        scope: ATTEMPT_ID,
        clientMutationId
      }),
    loadPendingSnapshot: () => opStore.findPendingByScope(ATTEMPT_ID),
    loadFailureCode: () => bgStore.get(ATTEMPT_ID)?.failure?.code,
    releaseReservation,
    clearPublicState: () => {
      bgStore.forget(ATTEMPT_ID)
    },
    now: () => 5000
  }
}

describe('background Forget (ledger #13)', () => {
  it('frees exactly one reservation, settles forgotten, retains the failure, never spawns/kills', () => {
    const harness = buildForgetHarness()
    const result = runForgetUnknownAgentLaunch(forgetDeps(harness), {
      scope: ATTEMPT_ID,
      expectedOperationId: OPERATION_ID,
      clientMutationId: CLIENT_MUTATION_ID
    })

    expect(result).toEqual({ status: 'forgotten' })
    // Exactly one reservation freed (structurally there is no spawn/kill dep).
    expect(harness.releaseReservation).toHaveBeenCalledTimes(1)
    expect(harness.releaseReservation).toHaveBeenCalledWith(LAUNCH_TOKEN)
    // The attempt is forgotten, keeps its unknown failure, and stamps forgottenAt.
    const attempt = harness.bgStore.get(ATTEMPT_ID)
    expect(attempt?.state).toBe('forgotten')
    expect(attempt?.failure?.code).toBe('launch_state_unknown')
    expect(attempt?.forgottenAt).toBe(5000)
    // Private pending attribution removed.
    expect(harness.opStore.findPendingByScope(ATTEMPT_ID)).toBeNull()
  })

  it('replays forgotten on a double submit without re-releasing', () => {
    const harness = buildForgetHarness()
    const params = {
      scope: ATTEMPT_ID,
      expectedOperationId: OPERATION_ID,
      clientMutationId: CLIENT_MUTATION_ID
    }
    expect(runForgetUnknownAgentLaunch(forgetDeps(harness), params)).toEqual({
      status: 'forgotten'
    })
    harness.releaseReservation.mockClear()
    expect(runForgetUnknownAgentLaunch(forgetDeps(harness), params)).toEqual({
      status: 'forgotten'
    })
    expect(harness.releaseReservation).not.toHaveBeenCalled()
  })

  it('rejects a stale operation id without mutation', () => {
    const harness = buildForgetHarness()
    const result = runForgetUnknownAgentLaunch(forgetDeps(harness), {
      scope: ATTEMPT_ID,
      expectedOperationId: 'op-stale',
      clientMutationId: CLIENT_MUTATION_ID
    })
    expect(result).toEqual({
      status: 'rejected',
      requestError: { code: 'stale_agent_launch_failure' }
    })
    expect(harness.releaseReservation).not.toHaveBeenCalled()
    expect(harness.bgStore.get(ATTEMPT_ID)?.state).toBe('pending')
  })
})

function buildRetryHarness(failure: PersistedAgentLaunchFailure) {
  const opStore = new AgentLaunchOperationStore()
  const bgStore = new BackgroundAgentLaunchStore()
  bgStore.create({
    attemptId: ATTEMPT_ID,
    worktreeId: WORKTREE_ID,
    operationId: OPERATION_ID,
    requestedAgent: 'custom-agent:codex:x',
    baseAgent: 'codex'
  })
  if (failure.code === 'launch_state_unknown') {
    bgStore.markUnknown(ATTEMPT_ID, failure)
  } else {
    bgStore.settleFailed(ATTEMPT_ID, failure)
  }
  const runLaunch = vi.fn().mockResolvedValue({
    status: 'launched',
    receipt: {
      requestedAgent: 'custom-agent:codex:x',
      baseAgent: 'codex',
      notices: [],
      launchToken: 'token-retry',
      catalogRevision: 1
    }
  })
  const inFlight = new Map<string, WorktreeRetryInFlight>()
  const deps = {
    operationStore: opStore,
    idempotencyKeyFor: (clientMutationId: string) =>
      agentLaunchIdempotencyKey({
        principal: { kind: 'local' },
        scope: ATTEMPT_ID,
        clientMutationId
      }),
    findInFlight: (key: string) => inFlight.get(key) ?? null,
    registerInFlight: (
      key: string,
      digest: string,
      promise: Promise<WorktreeRetryAgentLaunchResult>
    ): void => {
      inFlight.set(key, { payloadDigest: digest, promise })
    },
    resolveSettled: () => ({
      status: 'blocked' as const,
      failure: { code: 'launch_state_unknown' as const }
    }),
    loadDurableFailure: () => bgStore.get(ATTEMPT_ID)?.failure ?? null,
    resolveRecoveryGate: () =>
      retryRecoveryGateForFailureCode(bgStore.get(ATTEMPT_ID)?.failure?.code),
    runLaunch
  }
  return { deps, runLaunch, bgStore }
}

describe('background Retry gating (ledger #13)', () => {
  it('blocks a retry while launch_state_unknown WITHOUT running the launch', async () => {
    const { deps, runLaunch } = buildRetryHarness(unknownFailure())
    const result = await runWorktreeRetryAgentLaunch(deps, {
      scope: ATTEMPT_ID,
      expectedFailureId: FAILURE_ID,
      clientMutationId: CLIENT_MUTATION_ID,
      action: { kind: 'retry-same' }
    })
    expect(result).toEqual({ status: 'blocked', failure: { code: 'launch_state_unknown' } })
    expect(runLaunch).not.toHaveBeenCalled()
  })

  it('runs the launch for a retryable settled failure', async () => {
    const { deps, runLaunch } = buildRetryHarness(spawnFailedFailure())
    const result = await runWorktreeRetryAgentLaunch(deps, {
      scope: ATTEMPT_ID,
      expectedFailureId: FAILURE_ID,
      clientMutationId: CLIENT_MUTATION_ID,
      action: { kind: 'retry-same' }
    })
    expect(result).toMatchObject({ status: 'launched' })
    expect(runLaunch).toHaveBeenCalledTimes(1)
  })

  it('rejects a stale failure id without running the launch', async () => {
    const { deps, runLaunch } = buildRetryHarness(spawnFailedFailure())
    const result = await runWorktreeRetryAgentLaunch(deps, {
      scope: ATTEMPT_ID,
      expectedFailureId: 'wrong-id',
      clientMutationId: CLIENT_MUTATION_ID,
      action: { kind: 'retry-same' }
    })
    expect(result).toEqual({
      status: 'rejected',
      requestError: { code: 'stale_agent_launch_failure' }
    })
    expect(runLaunch).not.toHaveBeenCalled()
  })
})
