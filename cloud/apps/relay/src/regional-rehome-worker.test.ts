import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RelayAssignmentStore } from './assignment-store.js'
import type { RelayConfig } from './config.js'
import {
  combineRegionalRehomeSafety,
  REGIONAL_REHOME_RECONNECTS_PER_CELL_LIMIT,
  regionalRehomeSafetyFailure
} from './regional-rehome-safety.js'
import { startRegionalRehomeWorker } from './regional-rehome-worker.js'

describe('regional rehome worker', () => {
  afterEach(() => vi.restoreAllMocks())

  it('sends an incarnation- and source-epoch-bound drain without exposing identity', async () => {
    let now = 0
    const attempt = {
      attemptId: '11111111-1111-4111-8111-111111111111',
      userId: 'private-user',
      relayHostId: 'abcdefghijklmnop',
      preferredRegion: 'asia-east2',
      sourceCellId: 'production-gce-c7',
      sourceCellUrl: 'https://c7.relay.example.test',
      sourceCellIncarnation: '22222222-2222-4222-8222-222222222222',
      targetCellId: 'production-gce-c27',
      targetCellIncarnation: '33333333-3333-4333-8333-333333333333',
      previousEpoch: 7,
      assignmentEpoch: 8,
      drainGraceMs: 60_000,
      sendAttempts: 1
    }
    const claimRegionalRehome = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(attempt)
    const recordRegionalRehomeDrainReceipt = vi.fn().mockResolvedValue(true)
    const recordRegionalRehomeWorkerFailure = vi.fn().mockResolvedValue(undefined)
    const assignments = {
      claimRegionalRehome,
      recordRegionalRehomeDrainReceipt,
      recordRegionalRehomeWorkerFailure
    } as unknown as RelayAssignmentStore
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const worker = startRegionalRehomeWorker(config(), assignments, {
      now: () => now,
      safetySnapshot: () => safety(now),
      intervalMs: 60_000,
      identityToken: async (audience) => {
        expect(audience).toBe('https://relay.example.test/v1/admin/host-drain')
        return 'secret-token'
      },
      fetch: (async (url, init) => {
        requests.push({ url: String(url), init })
        return Response.json({ v: 1, outcome: 'accepted' })
      }) as typeof fetch
    })!
    await settleWorker()
    now = 1_000
    await worker.run()
    worker.stop()

    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('https://c7.relay.example.test/v1/admin/host-drain')
    expect(requests[0]!.url).not.toContain('secret-token')
    expect(requests[0]!.init?.headers).toMatchObject({
      authorization: 'Bearer secret-token'
    })
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
      v: 1,
      attemptId: '11111111-1111-4111-8111-111111111111',
      userId: 'private-user',
      relayHostId: 'abcdefghijklmnop',
      sourceCellId: 'production-gce-c7',
      sourceCellIncarnation: '22222222-2222-4222-8222-222222222222',
      sourceAssignmentEpoch: 7,
      graceMs: 60_000
    })
    expect(recordRegionalRehomeDrainReceipt).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'accepted'
    )
    const logs = warn.mock.calls.map((call) => String(call[0])).join('\n')
    expect(logs).not.toContain('private-user')
    expect(logs).not.toContain('abcdefghijklmnop')
  })

  it('fails closed before the observation gate and records bounded dispatch failures', async () => {
    let now = 0
    const attempt = {
      attemptId: '11111111-1111-4111-8111-111111111111',
      userId: 'private-user',
      relayHostId: 'abcdefghijklmnop',
      sourceCellId: 'source',
      sourceCellUrl: 'https://source.example.test',
      sourceCellIncarnation: '22222222-2222-4222-8222-222222222222',
      targetCellId: 'target',
      previousEpoch: 1,
      assignmentEpoch: 2,
      drainGraceMs: 60_000,
      sendAttempts: 1
    }
    const claimRegionalRehome = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(attempt)
    const assignments = {
      claimRegionalRehome,
      recordRegionalRehomeDispatchFailure: vi.fn().mockResolvedValue(undefined),
      recordRegionalRehomeWorkerFailure: vi.fn().mockResolvedValue(undefined)
    } as unknown as RelayAssignmentStore
    const worker = startRegionalRehomeWorker(config(), assignments, {
      now: () => now,
      safetySnapshot: () => safety(now),
      intervalMs: 60_000,
      identityToken: async () => {
        throw new Error('token unavailable')
      }
    })!
    await settleWorker()
    claimRegionalRehome.mockClear()
    now = 100
    await worker.run()
    worker.stop()
    expect(assignments.recordRegionalRehomeDispatchFailure).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111'
    )
    expect(assignments.recordRegionalRehomeWorkerFailure).not.toHaveBeenCalled()
  })

  it('passes unsafe process telemetry to the durable claim gate', async () => {
    let now = 0
    let sqlFailures = 0
    const claimRegionalRehome = vi.fn().mockResolvedValue(null)
    const assignments = {
      claimRegionalRehome
    } as unknown as RelayAssignmentStore
    const worker = startRegionalRehomeWorker(config(), assignments, {
      now: () => now,
      safetySnapshot: () => ({ ...safety(now), sqlFailures }),
      intervalMs: 60_000
    })!
    await settleWorker()
    claimRegionalRehome.mockClear()
    now = 100
    sqlFailures = 1
    await worker.run()
    worker.stop()

    expect(claimRegionalRehome).toHaveBeenCalledWith(
      expect.objectContaining({ observedAt: 100, sqlFailures: 1 })
    )
  })

  it('starts inert on directors so durable control can enable without a restart', async () => {
    let now = 0
    const claimRegionalRehome = vi.fn().mockResolvedValue(null)
    const assignments = {
      claimRegionalRehome
    } as unknown as RelayAssignmentStore
    const worker = startRegionalRehomeWorker(
      config(),
      assignments,
      {
        now: () => now,
        safetySnapshot: () => safety(now),
        intervalMs: 60_000
      }
    )
    expect(worker).not.toBeNull()
    await settleWorker()
    claimRegionalRehome.mockClear()
    now = 100
    await worker!.run()
    worker!.stop()
    expect(claimRegionalRehome).toHaveBeenCalledOnce()

    expect(
      startRegionalRehomeWorker(
        config({ role: 'cell' }),
        {} as RelayAssignmentStore,
        { safetySnapshot: () => safety(1) }
      )
    ).toBeNull()
  })

  it('treats the reconnect threshold as per-cell and excludes the director', () => {
    const cells = 2
    const limit = cells * REGIONAL_REHOME_RECONNECTS_PER_CELL_LIMIT
    const processSafety = { ...safety(100), reconnects: limit * 10 }
    const fleetSafety = { ...safety(100), reconnects: limit }
    expect(regionalRehomeSafetyFailure(
      combineRegionalRehomeSafety(processSafety, fleetSafety),
      100,
      cells
    )).toBeNull()
    expect(regionalRehomeSafetyFailure(
      combineRegionalRehomeSafety(processSafety, { ...fleetSafety, reconnects: limit + 1 }),
      100,
      cells
    )).toBe('elevated_reconnects')
  })
})

function config(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    role: 'director',
    rehomeAudience: 'https://relay.example.test/v1/admin/host-drain',
    rehomeDirectorServiceAccount: 'relay-director@example.test',
    ...overrides
  } as RelayConfig
}

function safety(observedAt: number) {
  return {
    requiredCells: 2,
    missingCells: 0,
    observedAt,
    sqlFailures: 0,
    reconnects: 0,
    controlActivityRecoveryFailures: 0,
    databasePoolTotal: 3,
    databasePoolIdle: 3,
    databasePoolWaiting: 0,
    databasePoolWaitersMax: 0,
    databasePoolOldestWaitMs: 0,
    databasePoolWaitMsMax: 0
  }
}

async function settleWorker(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
