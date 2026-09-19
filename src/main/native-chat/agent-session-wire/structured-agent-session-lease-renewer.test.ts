import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { StructuredAgentSessionLeaseRenewer } from './structured-agent-session-lease-renewer'

const NOW = 1_800_000_000_000
const roots: string[] = []

async function liveStore(): Promise<AgentSessionRecordStore> {
  const root = await mkdtemp(join(tmpdir(), 'orca-lease-renewer-'))
  roots.push(root)
  const store = await AgentSessionRecordStore.open({ directory: root, hostId: 'local' })
  const reserved = await store.reserveOwner({
    sessionId: 'session-renewal',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: root },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: 'spawn-renewal',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'test',
      operationId: `${NOW}-00000000000000000000000000000001`,
      fingerprint: 'create'
    },
    now: NOW
  })
  await store.commitProcessIdentity({
    sessionId: 'session-renewal',
    fence: reserved.record.lease.runtimeFence,
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: NOW - 1_000,
      spawnToken: 'spawn-renewal'
    },
    now: NOW
  })
  await store.proveOwner({
    sessionId: 'session-renewal',
    fence: reserved.record.lease.runtimeFence,
    link: {
      linkId: 'link-renewal',
      handle: { provider: 'codex', threadId: 'thread-renewal' },
      origin: 'created',
      mintedAtFence: reserved.record.lease.runtimeFence,
      observedAt: NOW
    },
    now: NOW
  })
  return store
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('structured agent-session lease renewal', () => {
  it('isolates renewal failures per live record', async () => {
    const records = ['a', 'b'].map((suffix, index) => {
      const sessionId = `session-${suffix}`
      return agentSessionRecordFixture(
        agentSessionLeaseFixture({
          sessionId,
          runtimeKind: 'native',
          runtimeFence: index + 1,
          ownerProcess: {
            hostId: 'local',
            pid: 4200 + index,
            processStartTimeMs: NOW - 1_000,
            spawnToken: `spawn-${suffix}`
          },
          reservedSpawnToken: `spawn-${suffix}`,
          lastRenewedAt: NOW,
          leaseDeadlineAt: NOW + 30_000
        })
      )
    })
    const renewLeases = vi.fn(async (renewals: readonly { sessionId: string }[]) =>
      renewals.map((renewal) => records.find((record) => record.sessionId === renewal.sessionId)!)
    )
    const probeMany = vi.fn(
      async () =>
        new Map(
          records.map((record) => [
            record.sessionId,
            { outcome: 'identity-matched', matchedOn: ['spawn-token'] } as const
          ])
        )
    )
    const renewer = new StructuredAgentSessionLeaseRenewer({
      store: { listRecords: () => records, renewLeases } as unknown as AgentSessionRecordStore,
      probe: vi.fn(),
      probeMany,
      now: () => NOW + 10_000
    })

    await renewer.renewNow()

    expect(probeMany).toHaveBeenCalledOnce()
    expect(renewLeases).toHaveBeenCalledOnce()
    expect(renewLeases.mock.calls[0]?.[0]).toHaveLength(2)
  })

  it('keeps a healthy lease alive when a sibling renewal is superseded', async () => {
    const records = ['a', 'b'].map((suffix, index) =>
      agentSessionRecordFixture(
        agentSessionLeaseFixture({
          sessionId: `session-${suffix}`,
          runtimeKind: 'native',
          runtimeFence: index + 1,
          ownerProcess: {
            hostId: 'local',
            pid: 4200 + index,
            processStartTimeMs: NOW - 1_000,
            spawnToken: `spawn-${suffix}`
          },
          reservedSpawnToken: `spawn-${suffix}`,
          lastRenewedAt: NOW,
          leaseDeadlineAt: NOW + 30_000
        })
      )
    )
    const renewLeases = vi.fn(async () => {
      throw new Error('agent_session_checkpoint_stale')
    })
    const renewLease = vi.fn(async (renewal: { sessionId: string }) => {
      if (renewal.sessionId === 'session-b') {
        throw new Error('agent_session_checkpoint_stale')
      }
      return records[0]!
    })
    const onRenewed = vi.fn()
    const onError = vi.fn()
    const renewer = new StructuredAgentSessionLeaseRenewer({
      store: {
        listRecords: () => records,
        renewLeases,
        renewLease
      } as unknown as AgentSessionRecordStore,
      probe: async () => ({
        outcome: 'identity-matched' as const,
        matchedOn: ['spawn-token' as const]
      }),
      now: () => NOW + 10_000,
      onRenewed,
      onError
    })

    await renewer.renewNow()

    expect(renewLeases).toHaveBeenCalledOnce()
    expect(onRenewed).toHaveBeenCalledOnce()
    expect(renewLease).toHaveBeenCalledTimes(2)
    expect(onRenewed).toHaveBeenCalledWith(records[0])
    expect(onError).toHaveBeenCalledWith({
      sessionId: 'session-b',
      error: expect.objectContaining({ message: 'agent_session_checkpoint_stale' })
    })
  })

  it('drives renewal on the production interval', async () => {
    vi.useFakeTimers()
    const store = await liveStore()
    let now = NOW
    const renewer = new StructuredAgentSessionLeaseRenewer({
      store,
      probe: async () => ({
        outcome: 'identity-matched',
        matchedOn: ['process-start-time']
      }),
      now: () => now
    })
    try {
      renewer.start()
      now += 10_000
      await vi.advanceTimersByTimeAsync(10_000)
      // Real-timer poll: the suite's default 1000ms budget is tight under a loaded CI shard.
      await vi.waitFor(
        () => expect(store.getRecord('session-renewal')?.lease.lastRenewedAt).toBe(now),
        { timeout: 5000 }
      )
    } finally {
      renewer.stop()
      vi.useRealTimers()
    }
  })

  it('renews every live owner only after re-proving its child identity', async () => {
    const store = await liveStore()
    const probe = vi.fn(async () => ({
      outcome: 'identity-matched' as const,
      matchedOn: ['process-start-time' as const]
    }))
    const onRenewed = vi.fn()
    const renewer = new StructuredAgentSessionLeaseRenewer({
      store,
      probe,
      now: () => NOW + 10_000,
      onRenewed
    })

    await renewer.renewNow()

    expect(probe).toHaveBeenCalledOnce()
    expect(store.getRecord('session-renewal')?.lease.lastRenewedAt).toBe(NOW + 10_000)
    expect(onRenewed).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-renewal' })
    )
  })

  it('stops extending the lease when child proof is no longer sufficient', async () => {
    const store = await liveStore()
    const onError = vi.fn()
    const renewer = new StructuredAgentSessionLeaseRenewer({
      store,
      probe: async () => ({ outcome: 'indeterminate', reason: 'probe unavailable' }),
      now: () => NOW + 10_000,
      onError
    })

    await renewer.renewNow()

    expect(store.getRecord('session-renewal')?.lease.lastRenewedAt).toBe(NOW)
    expect(onError).toHaveBeenCalledWith({
      sessionId: 'session-renewal',
      error: expect.any(Error)
    })
  })

  it('never extends the lease of a native record parked in recovery', async () => {
    // The host cannot vouch for a native child it holds no transport to; renewing while
    // recovering keeps an orphan pid's lease alive and reads as a healthy owner.
    const store = await liveStore()
    await store.transitionHandoff('session-renewal', (record) => ({
      ...record,
      lease: { ...record.lease, handoffStage: 'recovering' }
    }))
    const probe = vi.fn(async () => ({
      outcome: 'identity-matched' as const,
      matchedOn: ['process-start-time' as const]
    }))
    const renewer = new StructuredAgentSessionLeaseRenewer({
      store,
      probe,
      now: () => NOW + 10_000
    })

    await renewer.renewNow()

    expect(probe).not.toHaveBeenCalled()
    expect(store.getRecord('session-renewal')?.lease.lastRenewedAt).toBe(NOW)
  })

  it('routes a proven dead TUI owner into handoff recovery', async () => {
    const store = await liveStore()
    await store.transitionHandoff('session-renewal', (record) => ({
      ...record,
      lease: { ...record.lease, runtimeKind: 'tui' }
    }))
    const onDeadTuiOwner = vi.fn(async () => undefined)
    const onError = vi.fn()
    const renewer = new StructuredAgentSessionLeaseRenewer({
      store,
      probe: async () => ({ outcome: 'pid-absent' }),
      now: () => NOW + 10_000,
      onDeadTuiOwner,
      onError
    })

    await renewer.renewNow()

    expect(onDeadTuiOwner).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-renewal' }),
      { outcome: 'pid-absent' }
    )
    expect(store.getRecord('session-renewal')?.lease.lastRenewedAt).toBe(NOW)
    expect(onError).not.toHaveBeenCalled()
  })
})

it('bounds unresolved recovery attempts and retries a superseding identity on the same scheduler', async () => {
  const store = await liveStore()
  await store.transitionHandoff('session-renewal', (record) => ({
    ...record,
    lease: { ...record.lease, handoffStage: 'recovering' }
  }))
  vi.useFakeTimers()
  try {
    let clock = NOW
    const recover = vi.fn(async () => {})
    const renewer = new StructuredAgentSessionLeaseRenewer({
      store,
      probe: async () => ({ outcome: 'indeterminate', reason: 'no contact' }),
      now: () => clock,
      onRecoveryCandidate: recover,
      intervalMs: 10
    })

    for (let tick = 0; tick < 100; tick += 1) {
      clock += 10
      await renewer.renewNow()
    }
    expect(recover).toHaveBeenCalledTimes(6)
    expect(store.getRecord('session-renewal')?.lease.ownerProcess).not.toBeNull()
    await store.transitionHandoff('session-renewal', (record) => ({
      ...record,
      lease: { ...record.lease, runtimeFence: record.lease.runtimeFence + 1 }
    }))
    clock += 10
    await renewer.renewNow()
    expect(recover).toHaveBeenCalledTimes(7)
    renewer.start()
    renewer.stop()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('retries durable receipts after legacy flags clear and gives expiry a final bounded attempt', async () => {
  const store = await liveStore()
  let clock = NOW
  await store.transitionHandoff('session-renewal', (record) => ({
    ...record,
    lease: {
      ...record.lease,
      claimStatus: 'released',
      ownerProcess: null,
      settlementRetryRequired: undefined
    },
    retirements: {
      abandonedCount: 0,
      receipts: [
        {
          id: 'receipt',
          fence: record.lease.runtimeFence,
          observedAt: NOW,
          capture: {
            sessionId: record.sessionId,
            epoch: 'epoch',
            incarnation: 'immutable',
            throughSequence: 1,
            items: [],
            submissions: []
          }
        }
      ]
    }
  }))
  const recover = vi.fn(async (): Promise<void> => {
    throw new Error('journal temporarily unavailable')
  })
  const renewer = new StructuredAgentSessionLeaseRenewer({
    store,
    now: () => clock,
    probe: async () => ({ outcome: 'pid-absent' }),
    onRecoveryCandidate: recover,
    intervalMs: 10
  })
  for (let tick = 0; tick < 100; tick += 1) {
    clock += 10
    await renewer.renewNow()
  }
  expect(recover).toHaveBeenCalledTimes(6)
  clock = NOW + 24 * 60 * 60 * 1000
  recover.mockImplementation(async () => {
    await store.transitionHandoff('session-renewal', (record) => ({
      ...record,
      retirements: {
        receipts: [],
        abandonedCount: 1,
        lastAbandonedReason: 'expired',
        lastAbandonedAt: clock
      }
    }))
  })
  await renewer.renewNow()
  await renewer.renewNow()
  expect(recover).toHaveBeenCalledTimes(7)
  expect(store.getRecord('session-renewal')?.retirements?.receipts).toEqual([])
})

it('repairs an unopened released session after transient failure without a legacy retry flag', async () => {
  const { openAgentSessionJournal } = await import('../agent-session-journal/journal-store-factory')
  const { preserveStructuredSessionRetirement, retryStructuredSessionRetirements } =
    await import('./structured-agent-session-retirement')
  const store = await liveStore()
  const root = await mkdtemp(join(tmpdir(), 'receipt-maintenance-'))
  roots.push(root)
  const record = store.getRecord('session-renewal')!
  const journal = await openAgentSessionJournal({
    journalDir: root,
    identity: {
      sessionId: record.sessionId,
      hostId: 'local',
      workspaceId: 'folder',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'thread' }
    }
  })
  let clock = NOW
  const context = { store, journal, sessionId: record.sessionId, now: () => clock }
  try {
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread', turnId: 'old', ordinal: 1 },
      { kind: 'turn', turnId: 'old', state: 'running' },
      { fence: record.lease.runtimeFence }
    )
    await store.evictProvenDeadOwner({
      sessionId: record.sessionId,
      expectedFence: record.lease.runtimeFence,
      probe: { outcome: 'pid-absent' },
      now: clock
    })
    expect(await preserveStructuredSessionRetirement(context)).toBe(true)
    expect(store.getRecord(record.sessionId)?.lease.settlementRetryRequired).toBeUndefined()
    vi.spyOn(journal.retirement, 'repairItem').mockRejectedValueOnce(
      new Error('temporary write failure')
    )
    const renewer = new StructuredAgentSessionLeaseRenewer({
      store,
      now: () => clock,
      probe: async () => ({ outcome: 'pid-absent' }),
      intervalMs: 10,
      onRecoveryCandidate: async () => {
        await retryStructuredSessionRetirements(context)
      }
    })
    await renewer.renewNow()
    expect(store.getRecord(record.sessionId)?.retirements?.receipts).toHaveLength(1)
    clock += 10
    await renewer.renewNow()
    expect(store.getRecord(record.sessionId)?.retirements?.receipts).toEqual([])
    expect(journal.snapshot().items[0].body).toMatchObject({ kind: 'turn', state: 'unverifiable' })
  } finally {
    await journal.close()
  }
})
