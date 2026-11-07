import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY } from '../../../../../shared/orchestration-runtime-capabilities'
import { createIdleSyncHarness } from '../synchronization/federation-sync-test-harness'
import { FederationAcknowledgmentRecovery } from './federation-acknowledgment-recovery'

function requestField(params: unknown, key: string): unknown {
  return typeof params === 'object' && params !== null
    ? Object.fromEntries(Object.entries(params))[key]
    : undefined
}

function relayItem(sequence: number) {
  return {
    dispatch_id: 'dispatch_remote',
    direction: 'to_home' as const,
    sequence,
    message_id: `message_${sequence}`,
    kind: 'status',
    payload: JSON.stringify({ subject: 'Progress', body: `Update ${sequence}`, type: 'status' })
  }
}

describe('FederationAcknowledgmentRecovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('backs off a failing row without holding back healthy acknowledgment debt', async () => {
    const pending = [
      { dispatchId: 'unreachable', rowId: 1 },
      { dispatchId: 'healthy', rowId: 2 }
    ]
    const attempts: { dispatchId: string; at: number }[] = []
    const recovery = new FederationAcknowledgmentRecovery({
      findNextAfter: (afterRowId) => pending.find((row) => row.rowId > afterRowId),
      acknowledgedThrough: () => 0,
      sync: async (dispatchId) => {
        attempts.push({ dispatchId, at: Date.now() })
        if (dispatchId === 'unreachable') {
          throw new Error('Unknown environment')
        }
        pending.splice(
          pending.findIndex((row) => row.dispatchId === dispatchId),
          1
        )
      }
    })

    recovery.ensure()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(attempts.find((attempt) => attempt.dispatchId === 'healthy')?.at).toBe(1_000)
    expect(
      attempts.filter((attempt) => attempt.dispatchId === 'unreachable').map(({ at }) => at)
    ).toEqual([0, 2_000, 6_000])
    recovery.reset()
  })

  it('backs off a row whose sync succeeds without settling it, and settles it once the host can', async () => {
    const pending = [{ dispatchId: 'awaiting-settlement', rowId: 1 }]
    let hostCanSettle = false
    const attempts: number[] = []
    const recovery = new FederationAcknowledgmentRecovery({
      findNextAfter: (afterRowId) => pending.find((row) => row.rowId > afterRowId),
      acknowledgedThrough: () => 0,
      sync: async () => {
        attempts.push(Date.now())
        if (hostCanSettle) {
          pending.length = 0
        }
      }
    })

    recovery.ensure()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(attempts).toEqual([0, 2_000, 6_000])

    hostCanSettle = true
    await vi.advanceTimersByTimeAsync(10_000)
    expect(attempts).toEqual([0, 2_000, 6_000, 14_000])
    expect(pending).toHaveLength(0)
    recovery.reset()
  })

  it('drains a large terminal backlog through real syncs without backing off', async () => {
    const backlog = 700
    const { runtime, remoteCall } = createIdleSyncHarness(backlog, 3)
    const db = runtime.getOrchestrationDb()
    const duplicate = db.insertMessage({ from: 'term_worker', to: 'term_home', subject: 'Replay' })
    db.importFederatedRelayItem = () => ({ message: duplicate, duplicate: true })
    const acknowledged = (): number =>
      db.getFederatedDispatch('dispatch_remote')?.to_home_acknowledged_sequence ?? 0
    let remoteAcknowledged = 0
    const pulls: number[] = []
    remoteCall.mockImplementation(async (_environmentId, method, params) => {
      if (method === 'status.get') {
        return {
          runtimeId: 'remote_epoch_1',
          capabilities: [ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY]
        }
      }
      if (method === 'orchestration.federationPull') {
        pulls.push(Date.now())
        const from = remoteAcknowledged
        const count = Math.min(Number(requestField(params, 'limit')), backlog - from)
        return {
          runtimeEpoch: 'remote_epoch_1',
          items: Array.from({ length: count }, (_, index) => relayItem(from + index + 1))
        }
      }
      if (method === 'orchestration.federationAck') {
        remoteAcknowledged = Number(requestField(params, 'throughSequence'))
        return { acknowledgedThrough: remoteAcknowledged }
      }
      throw new Error(`Unexpected method ${method}`)
    })
    const syncs: number[] = []
    const recovery = new FederationAcknowledgmentRecovery({
      findNextAfter: (afterRowId) =>
        afterRowId < 1 && acknowledged() < backlog
          ? { dispatchId: 'dispatch_remote', rowId: 1 }
          : undefined,
      sync: (dispatchId) => {
        syncs.push(Date.now())
        return runtime.syncOrchestrationFederatedDispatch(dispatchId)
      },
      acknowledgedThrough: () => acknowledged()
    })

    recovery.ensure()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(acknowledged()).toBe(backlog)
    // Each sync settles six pages; the backlog needs three syncs, one second apart.
    expect(syncs).toEqual([0, 1_000, 2_000])
    expect(pulls.length).toBeGreaterThan(syncs.length)
    recovery.reset()
  })
})
