import { describe, expect, it, vi } from 'vitest'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import {
  AgentLaunchOperationStore,
  canonicalPayloadDigest,
  type PendingAgentLaunchSnapshot
} from './agent-launch-operation-store'
import { retryRecoveryGateForFailureCode } from './agent-launch-reconciliation'
import {
  runForgetUnknownAgentLaunch,
  type ForgetUnknownAgentLaunchDeps
} from './agent-launch-worktree-forget'

function snapshot(): AgentLaunchSnapshot {
  return {
    version: 1,
    requestedAgent: 'claude',
    baseAgent: 'claude',
    displayLabel: 'Claude',
    mode: 'built-in',
    argv: ['claude'],
    agentEnv: {},
    capturedEnvPolicy: 'none',
    target: {
      platform: 'darwin',
      execution: 'native',
      shell: 'posix',
      isRemote: true,
      executionHostId: 'ssh:host'
    }
  }
}

const OPERATION_ID = 'op-unknown-1'
const WORKTREE_ID = 'wt-1'
const CLIENT_MUTATION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const IDEMPOTENCY_KEY = 'idem-forget-1'

function pending(): PendingAgentLaunchSnapshot {
  return {
    operationId: OPERATION_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    scope: WORKTREE_ID,
    clientMutationId: CLIENT_MUTATION_ID,
    payloadDigest: 'create-digest',
    launchToken: 'token-unknown-1',
    intent: 'interactive',
    snapshot: snapshot()
  }
}

type ForgetTestDeps = ForgetUnknownAgentLaunchDeps & {
  releaseReservation: ReturnType<typeof vi.fn>
  clearPublicState: ReturnType<typeof vi.fn>
}

function buildDeps(
  store: AgentLaunchOperationStore,
  overrides: Partial<ForgetUnknownAgentLaunchDeps> = {}
): ForgetTestDeps {
  const releaseReservation = vi.fn<(launchToken: string) => void>()
  const clearPublicState = vi.fn()
  return {
    operationStore: store,
    idempotencyKeyFor: () => IDEMPOTENCY_KEY,
    loadPendingSnapshot: () => store.getPending('token-unknown-1'),
    loadFailureCode: () => 'launch_state_unknown',
    releaseReservation,
    clearPublicState,
    now: () => 2000,
    ...overrides
  } as ForgetTestDeps
}

describe('runForgetUnknownAgentLaunch', () => {
  it('while unknown, Forget (not retry) releases the pending, token, and reservation', () => {
    const store = new AgentLaunchOperationStore()
    store.beginPending(pending())
    const deps = buildDeps(store)

    // Retry is blocked while unknown: the recovery gate refuses without mutation,
    // so the trio is untouched by a retry.
    expect(retryRecoveryGateForFailureCode('launch_state_unknown')).toEqual({
      kind: 'launch_state_unknown'
    })
    expect(store.getPending('token-unknown-1')).not.toBeNull()

    const result = runForgetUnknownAgentLaunch(deps, {
      scope: WORKTREE_ID,
      expectedOperationId: OPERATION_ID,
      clientMutationId: CLIENT_MUTATION_ID
    })

    expect(result).toEqual({ status: 'forgotten' })
    // Private attribution removed, reservation freed, public state cleared.
    expect(store.getPending('token-unknown-1')).toBeNull()
    expect(deps.releaseReservation).toHaveBeenCalledWith('token-unknown-1')
    expect(deps.clearPublicState).toHaveBeenCalledTimes(1)
    // Settled as `forgotten` for idempotency replay.
    expect(store.findSettledByIdempotencyKey(WORKTREE_ID, IDEMPOTENCY_KEY)).toMatchObject({
      status: 'forgotten',
      terminalId: null,
      failureId: null
    })
  })

  it('replays forgotten on a double-submit without re-releasing', () => {
    const store = new AgentLaunchOperationStore()
    store.beginPending(pending())
    const deps = buildDeps(store)
    const params = {
      scope: WORKTREE_ID,
      expectedOperationId: OPERATION_ID,
      clientMutationId: CLIENT_MUTATION_ID
    }

    expect(runForgetUnknownAgentLaunch(deps, params)).toEqual({ status: 'forgotten' })
    deps.releaseReservation.mockClear()
    deps.clearPublicState.mockClear()

    // Second submit: the settled ledger replays `forgotten`, mutating nothing.
    expect(runForgetUnknownAgentLaunch(deps, params)).toEqual({ status: 'forgotten' })
    expect(deps.releaseReservation).not.toHaveBeenCalled()
    expect(deps.clearPublicState).not.toHaveBeenCalled()
  })

  it('rejects a stale operation id without mutation', () => {
    const store = new AgentLaunchOperationStore()
    store.beginPending(pending())
    const deps = buildDeps(store)

    const result = runForgetUnknownAgentLaunch(deps, {
      scope: WORKTREE_ID,
      expectedOperationId: 'op-stale',
      clientMutationId: CLIENT_MUTATION_ID
    })

    expect(result).toEqual({
      status: 'rejected',
      requestError: { code: 'stale_agent_launch_failure' }
    })
    expect(store.getPending('token-unknown-1')).not.toBeNull()
    expect(deps.releaseReservation).not.toHaveBeenCalled()
  })

  it('refuses to forget a launch that is not launch_state_unknown', () => {
    const store = new AgentLaunchOperationStore()
    store.beginPending(pending())
    const deps = buildDeps(store, { loadFailureCode: () => 'spawn_failed' })

    const result = runForgetUnknownAgentLaunch(deps, {
      scope: WORKTREE_ID,
      expectedOperationId: OPERATION_ID,
      clientMutationId: CLIENT_MUTATION_ID
    })

    expect(result).toEqual({
      status: 'rejected',
      requestError: { code: 'stale_agent_launch_failure' }
    })
    expect(store.getPending('token-unknown-1')).not.toBeNull()
    expect(deps.releaseReservation).not.toHaveBeenCalled()
  })

  it('refuses to forget a launch admitted by another paired device', () => {
    const store = new AgentLaunchOperationStore()
    store.beginPending({
      ...pending(),
      principal: { kind: 'remote', id: 'mobile', deviceId: 'device-a' }
    })
    const deps = buildDeps(store)

    const result = runForgetUnknownAgentLaunch(deps, {
      scope: WORKTREE_ID,
      expectedOperationId: OPERATION_ID,
      clientMutationId: CLIENT_MUTATION_ID,
      callerPrincipal: { kind: 'remote', id: 'mobile', deviceId: 'device-b' }
    })

    // Same rejection as a missing pending: the other device learns nothing.
    expect(result).toEqual({
      status: 'rejected',
      requestError: { code: 'stale_agent_launch_failure' }
    })
    expect(store.getPending('token-unknown-1')).not.toBeNull()
    expect(deps.releaseReservation).not.toHaveBeenCalled()
    expect(deps.clearPublicState).not.toHaveBeenCalled()
  })

  it('forgets its own device launch and a pre-device-principal launch', () => {
    const caller = { kind: 'remote', id: 'mobile', deviceId: 'device-a' } as const
    const own = new AgentLaunchOperationStore()
    own.beginPending({ ...pending(), principal: caller })
    expect(
      runForgetUnknownAgentLaunch(buildDeps(own), {
        scope: WORKTREE_ID,
        expectedOperationId: OPERATION_ID,
        clientMutationId: CLIENT_MUTATION_ID,
        callerPrincipal: caller
      })
    ).toEqual({ status: 'forgotten' })

    // A durable row persisted before per-device principals carries the coarse
    // clientKind (or none at all) and must not become unforgettable.
    const legacy = new AgentLaunchOperationStore()
    legacy.beginPending({ ...pending(), principal: { kind: 'remote', id: 'mobile' } })
    expect(
      runForgetUnknownAgentLaunch(buildDeps(legacy), {
        scope: WORKTREE_ID,
        expectedOperationId: OPERATION_ID,
        clientMutationId: CLIENT_MUTATION_ID,
        callerPrincipal: caller
      })
    ).toEqual({ status: 'forgotten' })

    const principalLess = new AgentLaunchOperationStore()
    principalLess.beginPending(pending())
    expect(
      runForgetUnknownAgentLaunch(buildDeps(principalLess), {
        scope: WORKTREE_ID,
        expectedOperationId: OPERATION_ID,
        clientMutationId: CLIENT_MUTATION_ID,
        callerPrincipal: caller
      })
    ).toEqual({ status: 'forgotten' })
  })

  it('returns idempotency_conflict when the key was used with a different payload', () => {
    const store = new AgentLaunchOperationStore()
    store.recordSettled({
      operationId: 'op-other',
      idempotencyKey: IDEMPOTENCY_KEY,
      scope: WORKTREE_ID,
      payloadDigest: canonicalPayloadDigest({ kind: 'forget', expectedOperationId: 'op-other' }),
      status: 'forgotten',
      terminalId: null,
      failureId: null,
      settledAt: 1
    })
    const deps = buildDeps(store)

    const result = runForgetUnknownAgentLaunch(deps, {
      scope: WORKTREE_ID,
      expectedOperationId: OPERATION_ID,
      clientMutationId: CLIENT_MUTATION_ID
    })

    expect(result).toEqual({ status: 'rejected', requestError: { code: 'idempotency_conflict' } })
  })
})
