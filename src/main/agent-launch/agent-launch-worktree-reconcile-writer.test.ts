import { describe, expect, it, vi } from 'vitest'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import type { PersistedAgentLaunchFailure } from '../../shared/agent-launch-contract'
import {
  AgentLaunchOperationStore,
  type PendingAgentLaunchSnapshot
} from './agent-launch-operation-store'
import {
  reconcileAllPendingAgentLaunches,
  reconcileOnePendingAgentLaunch,
  type ReconcileAgentLaunchDeps,
  type ReconcileScopePersistence,
  type ResolvedLaunchLiveness
} from './agent-launch-worktree-reconcile-writer'

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
      isRemote: false,
      executionHostId: 'local'
    }
  }
}

function pending(overrides: Partial<PendingAgentLaunchSnapshot> = {}): PendingAgentLaunchSnapshot {
  return {
    operationId: 'op-1',
    idempotencyKey: 'idem-1',
    scope: 'wt-1',
    clientMutationId: 'cmid-1',
    payloadDigest: 'digest-1',
    launchToken: 'token-1',
    intent: 'interactive',
    snapshot: snapshot(),
    ...overrides
  }
}

function buildDeps(
  store: AgentLaunchOperationStore,
  liveness: ResolvedLaunchLiveness,
  persistence: ReconcileScopePersistence,
  settleBoundary = vi.fn()
): ReconcileAgentLaunchDeps {
  let failureCounter = 0
  return {
    operationStore: store,
    resolveLiveness: () => liveness,
    persistenceFor: () => persistence,
    settleBoundary,
    mintFailureId: () => `failure-${(failureCounter += 1)}`,
    now: () => 1000
  }
}

function persistenceSpy(): ReconcileScopePersistence & {
  launched: ReturnType<typeof vi.fn>
  failed: ReturnType<typeof vi.fn>
  unknown: ReturnType<typeof vi.fn>
} {
  const launched = vi.fn()
  const failed = vi.fn<(failure: PersistedAgentLaunchFailure) => void>()
  const unknown = vi.fn<(failure: PersistedAgentLaunchFailure) => void>()
  return {
    settleLaunched: launched,
    settleFailed: failed,
    markUnknown: unknown,
    launched,
    failed,
    unknown
  }
}

describe('reconcileOnePendingAgentLaunch', () => {
  it('live+attributed settles launched, clears pending, and registers the boundary', () => {
    const store = new AgentLaunchOperationStore()
    const entry = pending()
    store.rebuildPendingFrom([entry])
    const persistence = persistenceSpy()
    const settleBoundary = vi.fn()
    const deps = buildDeps(
      store,
      { kind: 'live', attributed: true, terminalId: 'term-9' },
      persistence,
      settleBoundary
    )

    const outcome = reconcileOnePendingAgentLaunch(deps, entry)

    expect(outcome).toEqual({ kind: 'launched' })
    expect(settleBoundary).toHaveBeenCalledWith('token-1', 'registered')
    expect(store.getPending('token-1')).toBeNull()
    expect(persistence.launched).toHaveBeenCalledTimes(1)
    const settled = store.findSettledByIdempotencyKey('wt-1', 'idem-1')
    expect(settled).toMatchObject({ status: 'launched', terminalId: 'term-9', failureId: null })
  })

  it('live+unattributed records invalid_launch_snapshot but keeps pending and reservation', () => {
    const store = new AgentLaunchOperationStore()
    const entry = pending()
    store.rebuildPendingFrom([entry])
    const persistence = persistenceSpy()
    const settleBoundary = vi.fn()
    const deps = buildDeps(
      store,
      { kind: 'live', attributed: false, terminalId: 'term-hijack' },
      persistence,
      settleBoundary
    )

    const outcome = reconcileOnePendingAgentLaunch(deps, entry)

    expect(outcome).toEqual({ kind: 'invalid_launch_snapshot' })
    // Coexistence with the live-but-unattributed terminal: nothing is settled or
    // released, so a later liveness event can re-derive this same pending.
    expect(settleBoundary).not.toHaveBeenCalled()
    expect(store.getPending('token-1')).not.toBeNull()
    expect(store.findSettledByIdempotencyKey('wt-1', 'idem-1')).toBeNull()
    expect(persistence.failed).not.toHaveBeenCalled()
    const failure = persistence.unknown.mock.calls[0][0]
    expect(failure).toMatchObject({ code: 'invalid_launch_snapshot', intent: 'interactive' })
  })

  it('invalid_launch_snapshot converts to a retryable spawn_failed once the conflicting terminal is gone', () => {
    const store = new AgentLaunchOperationStore()
    const entry = pending()
    store.rebuildPendingFrom([entry])
    const persistence = persistenceSpy()
    const settleBoundary = vi.fn()
    const liveDeps = buildDeps(
      store,
      { kind: 'live', attributed: false, terminalId: 'term-hijack' },
      persistence,
      settleBoundary
    )
    expect(reconcileOnePendingAgentLaunch(liveDeps, entry)).toEqual({
      kind: 'invalid_launch_snapshot'
    })

    // The conflicting terminal exits; the next liveness event proves absence.
    const absentDeps = buildDeps(store, { kind: 'absent' }, persistence, settleBoundary)
    const outcome = reconcileOnePendingAgentLaunch(absentDeps, entry)

    expect(outcome).toEqual({ kind: 'spawn_failed' })
    expect(settleBoundary).toHaveBeenCalledWith('token-1', 'failed')
    expect(store.getPending('token-1')).toBeNull()
    const failure = persistence.failed.mock.calls[0][0]
    expect(failure).toMatchObject({ code: 'spawn_failed', intent: 'interactive' })
    expect(store.findSettledByIdempotencyKey('wt-1', 'idem-1')).toMatchObject({
      status: 'failed',
      terminalId: null
    })
  })

  it('absent settles spawn_failed with Retry available', () => {
    const store = new AgentLaunchOperationStore()
    const entry = pending()
    store.rebuildPendingFrom([entry])
    const persistence = persistenceSpy()
    const deps = buildDeps(store, { kind: 'absent' }, persistence)

    const outcome = reconcileOnePendingAgentLaunch(deps, entry)

    expect(outcome).toEqual({ kind: 'spawn_failed' })
    expect(store.getPending('token-1')).toBeNull()
    const failure = persistence.failed.mock.calls[0][0]
    expect(failure).toMatchObject({ code: 'spawn_failed', intent: 'interactive' })
    expect(store.findSettledByIdempotencyKey('wt-1', 'idem-1')).toMatchObject({
      status: 'failed',
      terminalId: null
    })
  })

  it('unknown writes the durable failure but keeps pending, snapshot, and reservation', () => {
    const store = new AgentLaunchOperationStore()
    const entry = pending()
    store.rebuildPendingFrom([entry])
    const persistence = persistenceSpy()
    const settleBoundary = vi.fn()
    const deps = buildDeps(store, { kind: 'unknown' }, persistence, settleBoundary)

    const outcome = reconcileOnePendingAgentLaunch(deps, entry)

    expect(outcome).toEqual({ kind: 'launch_state_unknown' })
    // Coexistence: the operation is NOT settled and nothing is released.
    expect(settleBoundary).not.toHaveBeenCalled()
    expect(store.getPending('token-1')).not.toBeNull()
    expect(store.findSettledByIdempotencyKey('wt-1', 'idem-1')).toBeNull()
    const failure = persistence.unknown.mock.calls[0][0]
    expect(failure).toMatchObject({ code: 'launch_state_unknown', intent: 'interactive' })
    expect(failure.failureId).toBeTruthy()
  })

  it('skips a snapshot a concurrent settle already cleared', () => {
    const store = new AgentLaunchOperationStore()
    const entry = pending()
    // Not begun in the store: models a token already settled/forgotten elsewhere.
    const persistence = persistenceSpy()
    const settleBoundary = vi.fn()
    const deps = buildDeps(store, { kind: 'absent' }, persistence, settleBoundary)

    const outcome = reconcileOnePendingAgentLaunch(deps, entry)

    expect(outcome).toBeNull()
    expect(settleBoundary).not.toHaveBeenCalled()
    expect(persistence.failed).not.toHaveBeenCalled()
  })
})

describe('reconcileAllPendingAgentLaunches', () => {
  it('reconciles only the filtered scope', () => {
    const store = new AgentLaunchOperationStore()
    store.rebuildPendingFrom([
      pending(),
      pending({
        scope: 'wt-2',
        launchToken: 'token-2',
        operationId: 'op-2',
        idempotencyKey: 'idem-2'
      })
    ])
    const persistence = persistenceSpy()
    const deps: ReconcileAgentLaunchDeps = {
      ...buildDeps(store, { kind: 'absent' }, persistence),
      persistenceFor: () => persistence
    }

    reconcileAllPendingAgentLaunches(deps, (entry) => entry.scope === 'wt-2')

    expect(store.getPending('token-2')).toBeNull()
    expect(store.getPending('token-1')).not.toBeNull()
    expect(persistence.failed).toHaveBeenCalledTimes(1)
  })
})
