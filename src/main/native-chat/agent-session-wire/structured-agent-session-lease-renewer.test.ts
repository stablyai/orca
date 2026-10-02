import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionOwnerEvidence } from '../../../shared/agent-session-lease-state'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { StructuredAgentSessionLeaseRenewer } from './structured-agent-session-lease-renewer'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'

const NOW = 1_800_000_000_000

/** A host whose memory proves nothing about any owner: every answer comes from the probe. */
const NO_MEMORY = {
  ownerProof: (record: AgentSessionRecord) => ({
    fence: record.lease.runtimeFence,
    attemptInFlight: false,
    owner: { kind: 'none' as const }
  }),
  landUnsettledAcquisition: async () => {},
  serialize: (_sessionId: string, task: () => Promise<void>) => task()
}
const roots: string[] = []

async function liveStore(): Promise<AgentSessionRecordStore> {
  const root = await mkdtemp(join(tmpdir(), 'orca-lease-renewer-'))
  roots.push(root)
  const store = await openTestAgentSessionRecordStore(root)
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
      ...NO_MEMORY,
      logger: recordingStructuredAgentSessionLogger().logger,
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
    const log = recordingStructuredAgentSessionLogger()
    const renewer = new StructuredAgentSessionLeaseRenewer({
      ...NO_MEMORY,
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
      logger: log.logger
    })

    await renewer.renewNow()

    expect(renewLeases).toHaveBeenCalledOnce()
    expect(renewLease).toHaveBeenCalledTimes(2)
    expect(log.entries.map((entry) => entry.fields)).toContainEqual({
      scope: 'lease-renewal',
      sessionId: 'session-b',
      error: expect.objectContaining({ message: 'agent_session_checkpoint_stale' })
    })
  })

  it('drives renewal on the production interval', async () => {
    vi.useFakeTimers()
    const store = await liveStore()
    let now = NOW
    const renewer = new StructuredAgentSessionLeaseRenewer({
      ...NO_MEMORY,
      logger: recordingStructuredAgentSessionLogger().logger,
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
      await renewer.stop()
      vi.useRealTimers()
    }
  })

  it('stops only once a renewal already in flight has finished writing', async () => {
    const store = await liveStore()
    let releaseProbe = (): void => {}
    const probing = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    const renewer = new StructuredAgentSessionLeaseRenewer({
      ...NO_MEMORY,
      logger: recordingStructuredAgentSessionLogger().logger,
      store,
      probe: async () => {
        await probing
        return { outcome: 'identity-matched', matchedOn: ['process-start-time'] }
      },
      now: () => NOW + 10_000
    })

    void renewer.renewNow()
    // Nothing has been written yet: the tick is parked in its probe.
    expect(store.getRecord('session-renewal')?.lease.lastRenewedAt).toBe(NOW)
    const stopped = renewer.stop()
    releaseProbe()
    await stopped

    expect(store.getRecord('session-renewal')?.lease.lastRenewedAt).toBe(NOW + 10_000)
  })

  it('renews every live owner only after re-proving its child identity', async () => {
    const store = await liveStore()
    const probe = vi.fn(async () => ({
      outcome: 'identity-matched' as const,
      matchedOn: ['process-start-time' as const]
    }))
    const renewer = new StructuredAgentSessionLeaseRenewer({
      ...NO_MEMORY,
      logger: recordingStructuredAgentSessionLogger().logger,
      store,
      probe,
      now: () => NOW + 10_000
    })

    await renewer.renewNow()

    expect(probe).toHaveBeenCalledOnce()
    expect(store.getRecord('session-renewal')?.lease.lastRenewedAt).toBe(NOW + 10_000)
  })

  it('stops extending the lease when child proof is no longer sufficient', async () => {
    const store = await liveStore()
    const log = recordingStructuredAgentSessionLogger()
    const renewer = new StructuredAgentSessionLeaseRenewer({
      ...NO_MEMORY,
      store,
      probe: async () => ({ outcome: 'indeterminate', reason: 'probe unavailable' }),
      now: () => NOW + 10_000,
      logger: log.logger
    })

    await renewer.renewNow()

    expect(store.getRecord('session-renewal')?.lease.lastRenewedAt).toBe(NOW)
    expect(log.entries.map((entry) => entry.fields)).toContainEqual({
      scope: 'lease-renewal',
      sessionId: 'session-renewal',
      error: expect.any(Error)
    })
  })

  it('never extends the lease of a record parked in recovery', async () => {
    // The host cannot vouch for a child it holds no transport to; renewing while
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
      ...NO_MEMORY,
      logger: recordingStructuredAgentSessionLogger().logger,
      store,
      probe,
      now: () => NOW + 10_000
    })

    await renewer.renewNow()

    expect(probe).not.toHaveBeenCalled()
    expect(store.getRecord('session-renewal')?.lease.lastRenewedAt).toBe(NOW)
  })

  describe('a lease the host can prove free', () => {
    function renewerWith(
      store: AgentSessionRecordStore,
      probe: AgentSessionOwnerProbe,
      owner: AgentSessionOwnerEvidence = { kind: 'none' },
      attemptInFlight = false
    ) {
      const log = recordingStructuredAgentSessionLogger()
      const renewer = new StructuredAgentSessionLeaseRenewer({
        ...NO_MEMORY,
        ownerProof: (record) => ({ fence: record.lease.runtimeFence, attemptInFlight, owner }),
        store,
        probe: async () => probe,
        now: () => NOW + 10_000,
        logger: log.logger
      })
      return { renewer, log }
    }

    it('converges a live lease whose owner the probe found dead, in one write', async () => {
      const store = await liveStore()
      const evict = vi.spyOn(store, 'evictProvenDeadOwner')
      const { renewer } = renewerWith(store, { outcome: 'pid-absent' })

      await renewer.renewNow()
      await renewer.renewNow()

      expect(evict).toHaveBeenCalledOnce()
      expect(store.getRecord('session-renewal')?.lease).toMatchObject({
        claimStatus: 'released',
        ownerProcess: null,
        runtimeFence: 2,
        deathEvidence: { kind: 'pid-absent', ownerFence: 1, lastProvenAliveAt: NOW }
      })
    })

    it('replays the release an exit this host watched never landed, without probing', async () => {
      const store = await liveStore()
      const probe = vi.fn()
      const renewer = new StructuredAgentSessionLeaseRenewer({
        ...NO_MEMORY,
        ownerProof: (record) => ({
          fence: record.lease.runtimeFence,
          attemptInFlight: false,
          owner: { kind: 'watched-exit', observedAt: NOW + 5, reason: 'crashed' }
        }),
        store,
        probe,
        now: () => NOW + 10_000,
        logger: recordingStructuredAgentSessionLogger().logger
      })

      await renewer.renewNow()

      expect(probe).not.toHaveBeenCalled()
      expect(store.getRecord('session-renewal')?.lease).toMatchObject({
        claimStatus: 'released',
        deathEvidence: { kind: 'exit-observed', detail: 'crashed', observedAt: NOW + 5 }
      })
    })

    it('reports a convergence that fails and lands it on a later tick', async () => {
      const store = await liveStore()
      vi.spyOn(store, 'evictProvenDeadOwner').mockRejectedValueOnce(new Error('disk unavailable'))
      const { renewer, log } = renewerWith(store, { outcome: 'pid-absent' })

      await renewer.renewNow()
      expect(store.getRecord('session-renewal')?.lease.claimStatus).toBe('live')
      expect(log.entries.map((entry) => entry.fields)).toContainEqual({
        scope: 'lease-convergence',
        sessionId: 'session-renewal',
        error: expect.objectContaining({ message: 'disk unavailable' })
      })

      await renewer.renewNow()
      expect(store.getRecord('session-renewal')?.lease.claimStatus).toBe('released')
    })

    it.each([
      ['the child this host runs, whose exit event is still on its way', { kind: 'runs' }, false],
      ['a lease an acquisition of this host is taking', { kind: 'none' }, true]
    ] as const)('leaves %s to its own owner', async (_label, owner, attemptInFlight) => {
      const store = await liveStore()
      const { renewer } = renewerWith(store, { outcome: 'pid-absent' }, owner, attemptInFlight)

      await renewer.renewNow()

      expect(store.getRecord('session-renewal')?.lease).toMatchObject({
        claimStatus: 'live',
        lastRenewedAt: NOW
      })
    })

    it('reports a child memory says runs once the probe proves it dead, and renews nothing', async () => {
      const store = await liveStore()
      const renew = vi.spyOn(store, 'renewLeases')
      const { renewer, log } = renewerWith(store, { outcome: 'pid-absent' }, { kind: 'runs' })

      await renewer.renewNow()

      expect(renew).not.toHaveBeenCalled()
      expect(log.entries.map((entry) => entry.fields)).toContainEqual({
        scope: 'lease-renewal',
        sessionId: 'session-renewal',
        probe: { outcome: 'pid-absent' }
      })
    })

    it('never queues behind an acquisition that began after the tick proved the lease free', async () => {
      const store = await liveStore()
      let attemptInFlight = false
      const serialize = vi.fn(() => new Promise<void>(() => {}))
      const renewer = new StructuredAgentSessionLeaseRenewer({
        ...NO_MEMORY,
        ownerProof: (record) => ({
          fence: record.lease.runtimeFence,
          attemptInFlight,
          owner: { kind: 'none' }
        }),
        serialize,
        store,
        probe: async () => {
          // A send's attach takes the session while the tick is probing.
          attemptInFlight = true
          return { outcome: 'pid-absent' }
        },
        now: () => NOW + 10_000,
        logger: recordingStructuredAgentSessionLogger().logger
      })

      await renewer.renewNow()

      expect(serialize).not.toHaveBeenCalled()
      expect(store.getRecord('session-renewal')?.lease.claimStatus).toBe('live')
    })

    it('never converges an owner proven alive or a conflicted claim', async () => {
      const store = await liveStore()
      const alive = renewerWith(store, {
        outcome: 'identity-matched',
        matchedOn: ['process-start-time']
      })
      await alive.renewer.renewNow()
      expect(store.getRecord('session-renewal')?.lease.claimStatus).toBe('live')

      await store.transitionHandoff('session-renewal', (record) => ({
        ...record,
        lease: { ...record.lease, claimStatus: 'conflicted' }
      }))
      await renewerWith(store, { outcome: 'pid-absent' }).renewer.renewNow()
      expect(store.getRecord('session-renewal')?.lease.claimStatus).toBe('conflicted')
    })
  })
})
