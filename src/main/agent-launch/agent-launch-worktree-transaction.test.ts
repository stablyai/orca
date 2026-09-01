import { describe, expect, it, vi } from 'vitest'
import {
  AgentLaunchOperationStore,
  type PendingAgentLaunchSnapshot
} from './agent-launch-operation-store'
import {
  runWorktreeAgentLaunchTransaction,
  type WorktreeAgentLaunchTransactionDeps,
  type WorktreeAgentLaunchTransactionParams,
  type WorktreePendingAgentLaunch
} from './agent-launch-worktree-transaction'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import type { AgentStartupPlan } from '../../shared/tui-agent-startup'
import type {
  AgentLaunchFailure,
  AgentLaunchReceipt,
  AgentLaunchRequestError
} from '../../shared/agent-launch-contract'
import type { ExecuteAgentLaunchResult } from './agent-launch-boundary'
import type { AdmissionPrincipal } from './agent-launch-admission-store'
import { retryRecoveryGateForFailureCode } from './agent-launch-reconciliation'
import { buildReconcileAgentLaunchDeps } from './agent-launch-reconcile-runtime-deps'
import { reconcileOnePendingAgentLaunch } from './agent-launch-worktree-reconcile-writer'

const SNAPSHOT: AgentLaunchSnapshot = {
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

const PLAN: AgentStartupPlan = {
  agent: 'claude',
  launchCommand: 'claude',
  expectedProcess: 'claude',
  followupPrompt: null,
  launchConfig: { agentArgs: '', agentEnv: {} }
}

const RECEIPT: AgentLaunchReceipt = {
  requestedAgent: 'claude',
  baseAgent: 'claude',
  notices: [],
  launchToken: 'tok-1',
  catalogRevision: 3,
  telemetry: { agentKind: 'claude-code', usedCustomAgent: false }
}

type CallLog = string[]

function makeDeps(overrides: {
  snapshot?: AgentLaunchSnapshot | null
  spawn?: WorktreeAgentLaunchTransactionDeps['spawn']
  log?: CallLog
}): {
  deps: WorktreeAgentLaunchTransactionDeps
  operationStore: AgentLaunchOperationStore
  settle: ReturnType<typeof vi.fn>
  persistPending: ReturnType<typeof vi.fn>
  persistFailure: ReturnType<typeof vi.fn>
  clearPublicPending: ReturnType<typeof vi.fn>
} {
  const log = overrides.log ?? []
  const operationStore = new AgentLaunchOperationStore()
  const settle = vi.fn((token: string, settlement: string) => {
    log.push(`settle:${settlement}:${token}`)
  })
  const persistPending = vi.fn((_pending: WorktreePendingAgentLaunch) => {
    log.push('persistPending')
  })
  const persistFailure = vi.fn(() => {
    log.push('persistFailure')
  })
  const clearPublicPending = vi.fn(() => {
    log.push('clearPublicPending')
  })
  const beginPending = operationStore.beginPending.bind(operationStore)
  operationStore.beginPending = ((entry) => {
    log.push('beginPending')
    return beginPending(entry)
  }) as typeof operationStore.beginPending
  const boundary = {
    pendingSnapshotFor: vi.fn(() =>
      overrides.snapshot === undefined ? SNAPSHOT : overrides.snapshot
    ),
    settleAgentLaunch: settle
  } as unknown as WorktreeAgentLaunchTransactionDeps['boundary']
  const spawn =
    overrides.spawn ??
    vi.fn(async (_plan: unknown, receipt: { launchToken: string }) => {
      log.push('spawn')
      expect(receipt.launchToken).toBe('tok-1')
      return { terminalId: 'term-1' }
    })
  let failureCounter = 0
  const deps: WorktreeAgentLaunchTransactionDeps = {
    boundary,
    operationStore,
    persistPending,
    spawn,
    clearPublicPending,
    persistFailure,
    mintFailureId: () => `fail-${(failureCounter += 1)}`,
    now: () => 1000
  }
  return { deps, operationStore, settle, persistPending, persistFailure, clearPublicPending }
}

function params(
  execute: () => Promise<ExecuteAgentLaunchResult>,
  extra?: Partial<WorktreeAgentLaunchTransactionParams>
): WorktreeAgentLaunchTransactionParams {
  return {
    operationId: 'op-1',
    idempotencyKey: 'idem-1',
    scope: 'wt-1',
    payloadDigest: 'digest-1',
    clientMutationId: null,
    requestedAgent: 'claude',
    intent: 'interactive',
    principal: { kind: 'local' },
    execute,
    ...extra
  }
}

describe('runWorktreeAgentLaunchTransaction', () => {
  it('persists pending (public + private) before spawning, then settles launched', async () => {
    const log: CallLog = []
    const { deps, operationStore } = makeDeps({ log })
    const outcome = await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({ ok: true, plan: PLAN, receipt: RECEIPT }))
    )
    expect(outcome).toEqual({ status: 'launched', receipt: RECEIPT, terminalId: 'term-1' })
    // Both persistence writes precede the writer; the private write is first.
    expect(log.indexOf('beginPending')).toBeLessThan(log.indexOf('spawn'))
    expect(log.indexOf('persistPending')).toBeLessThan(log.indexOf('spawn'))
    expect(log.indexOf('spawn')).toBeLessThan(log.indexOf('settle:registered:tok-1'))
    // Pending is cleared (public + private) and the ledger records launched.
    expect(operationStore.getPending('tok-1')).toBeNull()
    const settled = operationStore.findSettledByIdempotencyKey('wt-1', 'idem-1')
    expect(settled).toMatchObject({ status: 'launched', terminalId: 'term-1', failureId: null })
  })

  it('keeps only client-safe fields in the public pending metadata', async () => {
    const { deps, persistPending } = makeDeps({})
    await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({ ok: true, plan: PLAN, receipt: RECEIPT }), {
        priorFailureId: 'prev-fail'
      })
    )
    expect(persistPending).toHaveBeenCalledWith({
      operationId: 'op-1',
      requestedAgent: 'claude',
      priorFailureId: 'prev-fail'
    })
    const pending = persistPending.mock.calls[0][0]
    expect(Object.keys(pending).sort()).toEqual(['operationId', 'priorFailureId', 'requestedAgent'])
  })

  it('records a durable failure and spawns zero PTYs when execute fails', async () => {
    const log: CallLog = []
    const failure: AgentLaunchFailure = {
      code: 'agent_configuration_changed',
      requestedAgent: 'claude'
    }
    const { deps, operationStore, persistFailure } = makeDeps({ log })
    const outcome = await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({ ok: false, failure }))
    )
    expect(log).not.toContain('spawn')
    expect(log).not.toContain('beginPending')
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.failure).toMatchObject({
        code: 'agent_configuration_changed',
        version: 1,
        failureId: 'fail-1',
        intent: 'interactive',
        occurredAt: 1000
      })
    }
    expect(persistFailure).toHaveBeenCalledTimes(1)
    expect(operationStore.findSettledByIdempotencyKey('wt-1', 'idem-1')).toMatchObject({
      status: 'failed',
      failureId: 'fail-1',
      terminalId: null
    })
  })

  it('settles failed and records a durable failure when the writer throws', async () => {
    const log: CallLog = []
    const spawn = vi.fn(async () => {
      log.push('spawn')
      throw new Error('pty boom')
    })
    const { deps, operationStore, persistFailure } = makeDeps({ log, spawn })
    const outcome = await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({ ok: true, plan: PLAN, receipt: RECEIPT }))
    )
    // Pending was persisted before the writer, then rolled to a failure.
    expect(log.indexOf('beginPending')).toBeLessThan(log.indexOf('spawn'))
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(log).toContain('settle:failed:tok-1')
    expect(operationStore.getPending('tok-1')).toBeNull()
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.failure.code).toBe('spawn_failed')
    }
    expect(persistFailure).toHaveBeenCalledTimes(1)
  })

  it('maps a mid-spawn contact loss to launch_state_unknown WITHOUT settling', async () => {
    // Branch-review HIGH 1: a transport drop mid-spawn is not evidence the host
    // never spawned the agent (ssh-execution-boundary). Settling spawn_failed
    // would clear the pending and let Retry cold-start a duplicate.
    const log: CallLog = []
    const spawn = vi.fn(async () => {
      log.push('spawn')
      throw Object.assign(new Error('SSH connection lost, reconnecting...'), {
        code: 'CONNECTION_LOST'
      })
    })
    const { deps, operationStore, settle, persistFailure } = makeDeps({ log, spawn })
    const outcome = await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({ ok: true, plan: PLAN, receipt: RECEIPT }))
    )
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.failure).toMatchObject({ code: 'launch_state_unknown', intent: 'interactive' })
    }
    // The admission reservation is NOT settled failed and the operation is NOT
    // in the settled ledger — nothing has actually settled.
    expect(settle).not.toHaveBeenCalled()
    expect(operationStore.findSettledByIdempotencyKey('wt-1', 'idem-1')).toBeNull()
    // The private pending survives for host-evidence reconciliation, but the
    // in-flight guard is released so a reconcile pass may process the token.
    expect(operationStore.getPending('tok-1')).not.toBeNull()
    expect(operationStore.isSpawnInFlight('tok-1')).toBe(false)
    // The durable card is written once; its code blocks the server-side retry
    // gate, so no plain Retry can double-launch.
    expect(persistFailure).toHaveBeenCalledTimes(1)
    expect(retryRecoveryGateForFailureCode('launch_state_unknown')).toEqual({
      kind: 'launch_state_unknown'
    })
  })

  it('treats the post-dispatch ambiguity marker as contact loss', async () => {
    const spawn = vi.fn(async () => {
      throw Object.assign(new Error('execution_owner_unavailable'), {
        agentSessionOperationOutcome: 'unknown' as const
      })
    })
    const { deps, operationStore, settle } = makeDeps({ spawn })
    const outcome = await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({ ok: true, plan: PLAN, receipt: RECEIPT }))
    )
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.failure.code).toBe('launch_state_unknown')
    }
    expect(settle).not.toHaveBeenCalled()
    expect(operationStore.getPending('tok-1')).not.toBeNull()
  })

  it('reconciles the retained pending as launched when the token later proves live', async () => {
    // End-to-end no-double-launch proof: contact loss keeps the pending; a
    // provider-reconnect re-list that finds the token live ADOPTS the surviving
    // terminal (settles launched) instead of ever spawning a second agent.
    const spawn = vi.fn(async () => {
      throw Object.assign(new Error('lost'), { code: 'CONNECTION_LOST' })
    })
    const { deps, operationStore } = makeDeps({ spawn })
    await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({ ok: true, plan: PLAN, receipt: RECEIPT }))
    )
    const retained = operationStore.getPending('tok-1')
    expect(retained).not.toBeNull()

    const arm = {
      settleLaunched: vi.fn(),
      settleFailed: vi.fn(),
      markUnknown: vi.fn()
    }
    const settleBoundary = vi.fn((_token: string, _settlement: 'registered' | 'failed') => {})
    const reconcileDeps = buildReconcileAgentLaunchDeps({
      operationStore,
      liveTerminalByToken: () => ({ ptyId: 'ssh-term-1', worktreeId: 'wt-1' }),
      isHostAuthoritative: () => true,
      isHostTokenAuthoritative: () => true,
      expectedWorktreeId: (pending) => pending.scope,
      arms: {
        worktree: () => arm,
        automation: () => arm,
        orchestration: () => arm,
        background: () => arm
      },
      settleBoundary,
      mintFailureId: () => 'fail-r1',
      now: () => 2000
    })
    const outcome = reconcileOnePendingAgentLaunch(reconcileDeps, retained!)
    expect(outcome).toEqual({ kind: 'launched' })
    expect(settleBoundary).toHaveBeenCalledWith('tok-1', 'registered')
    expect(arm.settleLaunched).toHaveBeenCalledTimes(1)
    expect(operationStore.getPending('tok-1')).toBeNull()
    expect(operationStore.findSettledByIdempotencyKey('wt-1', 'idem-1')).toMatchObject({
      status: 'launched'
    })
  })

  it('marks the token spawn-in-flight for the whole beginPending→settle window', async () => {
    // Regression (L4-M2): a reconcile pass firing while the spawn is running
    // must be able to skip this token — the PTY registers it only after spawn
    // resolves, so mid-spawn it looks absent and would false-settle.
    const { deps, operationStore } = makeDeps({})
    let inFlightDuringSpawn: boolean | null = null
    deps.spawn = vi.fn(async () => {
      inFlightDuringSpawn = operationStore.isSpawnInFlight('tok-1')
      return { terminalId: 'term-1' }
    })
    await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({ ok: true, plan: PLAN, receipt: RECEIPT }))
    )
    expect(inFlightDuringSpawn).toBe(true)
    expect(operationStore.isSpawnInFlight('tok-1')).toBe(false)
  })

  it('clears the in-flight mark when the spawn throws', async () => {
    const spawn = vi.fn(async () => {
      throw new Error('pty boom')
    })
    const { deps, operationStore } = makeDeps({ spawn })
    await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({ ok: true, plan: PLAN, receipt: RECEIPT }))
    )
    expect(operationStore.isSpawnInFlight('tok-1')).toBe(false)
  })

  it('settles the ledger and clears the pending in ONE durable write (both arms)', async () => {
    // Regression (L3b-#9, tightened): the settled entry and the pending drop
    // must land in the same durable file image, so a crash leaves either the
    // pending attribution or the settled entry — never neither — and the settle
    // path pays one fsync'd write, not two.
    const { deps, operationStore } = makeDeps({})
    const writes: { pendingTokens: string[]; settledStatuses: string[] }[] = []
    operationStore.setDurablePersistence((state) => {
      writes.push({
        pendingTokens: state.pending.map((entry) => entry.launchToken),
        settledStatuses: state.settled.map((entry) => entry.status)
      })
    })

    await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({ ok: true, plan: PLAN, receipt: RECEIPT }))
    )
    // Write 1: beginPending (durable before the spawn). Write 2: settle+clear.
    expect(writes).toEqual([
      { pendingTokens: ['tok-1'], settledStatuses: [] },
      { pendingTokens: [], settledStatuses: ['launched'] }
    ])

    writes.length = 0
    deps.spawn = vi.fn(async () => {
      throw new Error('pty boom')
    })
    await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({
        ok: true,
        plan: PLAN,
        receipt: { ...RECEIPT, launchToken: 'tok-2' }
      }))
    )
    // Same operationId as arm 1, so the ledger entry is replaced, not appended.
    expect(writes).toEqual([
      { pendingTokens: ['tok-2'], settledStatuses: ['launched'] },
      { pendingTokens: [], settledStatuses: ['failed'] }
    ])
  })

  it('performs no owner-state write on a request error', async () => {
    const requestError: AgentLaunchRequestError = { code: 'idempotency_conflict' }
    const { deps, operationStore, persistFailure, persistPending } = makeDeps({})
    const outcome = await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({ ok: false, requestError }))
    )
    expect(outcome).toEqual({ status: 'request_error', requestError })
    expect(persistFailure).not.toHaveBeenCalled()
    expect(persistPending).not.toHaveBeenCalled()
    expect(operationStore.settledForScope('wt-1')).toHaveLength(0)
  })

  it('records the caller principal in the private pending snapshot', async () => {
    // The snapshot is the only durable carrier of who holds the capacity slot,
    // so a restart must rebuild the counter into this device's bucket.
    const principal: AdmissionPrincipal = { kind: 'remote', id: 'mobile', deviceId: 'dev-7' }
    const { deps, operationStore } = makeDeps({})
    const seen: (PendingAgentLaunchSnapshot | null)[] = []
    deps.spawn = vi.fn(async () => {
      seen.push(operationStore.getPending('tok-1'))
      return { terminalId: 'term-1' }
    })
    await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({ ok: true, plan: PLAN, receipt: RECEIPT }), { principal })
    )
    expect(seen[0]).toMatchObject({ principal, launchToken: 'tok-1', intent: 'interactive' })
  })

  it('releases the launch when beginPending throws instead of stranding it pending', async () => {
    const log: CallLog = []
    const { deps, operationStore, persistFailure, persistPending } = makeDeps({ log })
    operationStore.beginPending = (() => {
      throw new Error('durable write failed')
    }) as typeof operationStore.beginPending
    const outcome = await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({ ok: true, plan: PLAN, receipt: RECEIPT }))
    )
    expect(log).not.toContain('spawn')
    expect(log).toContain('settle:failed:tok-1')
    expect(persistPending).not.toHaveBeenCalled()
    expect(operationStore.getPending('tok-1')).toBeNull()
    expect(operationStore.isSpawnInFlight('tok-1')).toBe(false)
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.failure).toMatchObject({ code: 'spawn_failed', failureId: 'fail-1' })
    }
    expect(persistFailure).toHaveBeenCalledTimes(1)
  })

  it('rolls the private pending back when the public pending write throws', async () => {
    const log: CallLog = []
    const { deps, operationStore } = makeDeps({ log })
    deps.persistPending = vi.fn(() => {
      throw new Error('worktree meta write failed')
    })
    const outcome = await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({ ok: true, plan: PLAN, receipt: RECEIPT }))
    )
    expect(log).not.toContain('spawn')
    expect(log).toContain('settle:failed:tok-1')
    expect(operationStore.getPending('tok-1')).toBeNull()
    expect(operationStore.isSpawnInFlight('tok-1')).toBe(false)
    expect(outcome.status).toBe('failed')
  })

  it('drops the pending snapshot even when the rollback failure write throws', async () => {
    const { deps, operationStore } = makeDeps({})
    deps.persistPending = vi.fn(() => {
      throw new Error('worktree meta write failed')
    })
    deps.persistFailure = vi.fn(() => {
      throw new Error('failure write failed')
    })
    await expect(
      runWorktreeAgentLaunchTransaction(
        deps,
        params(async () => ({ ok: true, plan: PLAN, receipt: RECEIPT }))
      )
    ).rejects.toThrow('failure write failed')
    expect(operationStore.getPending('tok-1')).toBeNull()
    expect(operationStore.isSpawnInFlight('tok-1')).toBe(false)
  })

  it('fails closed and spawns nothing when the admitted snapshot is missing', async () => {
    const log: CallLog = []
    const { deps, persistFailure } = makeDeps({ log, snapshot: null })
    const outcome = await runWorktreeAgentLaunchTransaction(
      deps,
      params(async () => ({ ok: true, plan: PLAN, receipt: RECEIPT }))
    )
    expect(log).not.toContain('spawn')
    expect(log).toContain('settle:failed:tok-1')
    expect(outcome.status).toBe('failed')
    if (outcome.status === 'failed') {
      expect(outcome.failure.code).toBe('invalid_launch_snapshot')
    }
    expect(persistFailure).toHaveBeenCalledTimes(1)
  })
})
