import { describe, expect, it, vi, type Mock } from 'vitest'
import type { RelayConfig } from './config.js'
import { ReservePaceError } from './reserve-assignment.js'

const fakes = vi.hoisted(() => ({
  verifyRelayToken: vi.fn(async (token: string) => ({ sub: 'user-1', relayHostId: token }))
}))

vi.mock('./relay-token-verifier.js', () => ({
  createRelayTokenVerifier: () => fakes.verifyRelayToken,
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

import { createRelayApp } from './app.js'

const HOST = 'selecthost000001'

function usAssignment(extra: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    relayHostId: HOST,
    cellId: 'us-c1',
    cellUrl: 'https://us-c1.relay.example.test',
    region: 'us-central1' as const,
    assignmentEpoch: 3,
    leaseExpiresAt: Date.now() + 300_000,
    ...extra
  }
}

describe('Relay region selection counters', () => {
  it('counts a reserve sticky answer as selected, never as a fallback', async () => {
    const recordRegionSelection = vi.fn()
    const plan = vi.fn(async () => ({ kind: 'answer', lane: 'sticky', assignment: usAssignment() }))
    const response = await assign({ recordRegionSelection, plan }, { reconnect: true })

    expect(response.status).toBe(200)
    expect(recordRegionSelection.mock.calls).toEqual([
      [{ targetRegion: 'asia-east2', selectedRegion: 'us-central1', fallback: false }]
    ])
  })

  it('counts a reserve placement out of the target region as a fallback', async () => {
    const recordRegionSelection = vi.fn()
    const plan = vi.fn(async () => ({ kind: 'answer', lane: 'placement', assignment: usAssignment() }))
    await assign({ recordRegionSelection, plan }, { reconnect: true })

    expect(recordRegionSelection.mock.calls).toEqual([
      [{ targetRegion: 'asia-east2', selectedRegion: 'us-central1', fallback: true }]
    ])
  })

  it('counts a reserve-lane retry as an unavailable region', async () => {
    const recordRegionSelection = vi.fn()
    const plan = vi.fn(async () => ({ kind: 'retry', retryAfterSeconds: 2, reason: 'paced' }))
    const response = await assign({ recordRegionSelection, plan }, { reconnect: true })

    expect(response.status).toBe(503)
    expect(recordRegionSelection.mock.calls).toEqual([[{ targetRegion: 'asia-east2', fallback: false }]])
  })

  it('counts a reserve booking paced inside the database lane as an unavailable region', async () => {
    const recordRegionSelection = vi.fn()
    const assignFn = vi.fn(async () => {
      throw new ReservePaceError(3)
    })
    const response = await assign({ recordRegionSelection, assign: assignFn })

    expect(response.status).toBe(503)
    expect(recordRegionSelection.mock.calls).toEqual([[{ targetRegion: 'asia-east2', fallback: false }]])
  })

  it('does not count the existing row returned on the placement lane as a fallback', async () => {
    const recordRegionSelection = vi.fn()
    await assign({ recordRegionSelection, assign: vi.fn(async () => usAssignment()) })

    expect(recordRegionSelection.mock.calls).toEqual([
      [{ targetRegion: 'asia-east2', selectedRegion: 'us-central1', fallback: false }]
    ])
  })

  it('counts a placement out of the target region on any lane as a fallback', async () => {
    const recordRegionSelection = vi.fn()
    // The reconnect verifies on the sticky lane; the store then re-places the host.
    await assign(
      {
        recordRegionSelection,
        assign: vi.fn(async () => usAssignment({ placed: true })),
        resolve: vi.fn(async () => usAssignment())
      },
      { reconnect: true }
    )

    expect(recordRegionSelection.mock.calls).toEqual([
      [{ targetRegion: 'asia-east2', selectedRegion: 'us-central1', fallback: true }]
    ])
  })

  it('counts a drain-return re-placement out of the target region as a fallback', async () => {
    const recordRegionSelection = vi.fn()
    const recordAssignmentAdmission = vi.fn()
    await assign(
      {
        recordRegionSelection,
        recordAssignmentAdmission,
        assign: vi.fn(async () => usAssignment({ placed: true })),
        resolve: vi.fn(async () => usAssignment({ cellId: 'asia-c1', region: 'asia-east2', homeCellRollIsolated: true }))
      },
      { reconnect: true }
    )

    expect(recordAssignmentAdmission).toHaveBeenCalledWith('drain-return')
    expect(recordRegionSelection.mock.calls).toEqual([
      [{ targetRegion: 'asia-east2', selectedRegion: 'us-central1', fallback: true }]
    ])
  })

  it('never counts a rehome as a fallback, and gives a rehomed new session no region window', async () => {
    const recordRegionSelection = vi.fn()
    const exchangeRegionCorrection = vi.fn()
    const plan = vi.fn(async () => ({
      kind: 'answer',
      lane: 'rehome',
      assignment: usAssignment({ cellId: 'asia-c1', region: 'asia-east2' })
    }))
    const response = await assign(
      { recordRegionSelection, plan, exchangeRegionCorrection },
      { reconnect: true, regionCorrection: { v: 1, action: 'issue-window' } }
    )

    expect(response.status).toBe(200)
    expect(await response.json()).not.toHaveProperty('regionCorrection')
    expect(exchangeRegionCorrection).not.toHaveBeenCalled()
    expect(plan).toHaveBeenCalledWith(
      { userId: 'user-1', relayHostId: HOST },
      { reconnect: true, region: 'asia-east2', regionCorrection: true, preferred: true }
    )
    expect(recordRegionSelection.mock.calls).toEqual([
      [{ targetRegion: 'asia-east2', selectedRegion: 'asia-east2', fallback: false }]
    ])
  })

  it('tells the plan a region is the host’s own only when placement follows it', async () => {
    const plan = vi.fn(async () => ({ kind: 'database' }))
    const placed = vi.fn(async () => usAssignment())
    await assign({ recordRegionSelection: vi.fn(), plan, assign: placed }, { reconnect: true }, { regionalPlacementEnabled: false })
    await assign({ recordRegionSelection: vi.fn(), plan, assign: placed }, { reconnect: true, preferredRegion: undefined })
    // Asking for the default region while regional placement is off is not a preference either.
    await assign(
      { recordRegionSelection: vi.fn(), plan, assign: placed },
      { reconnect: true, preferredRegion: 'us-central1' },
      { regionalPlacementEnabled: false }
    )
    const unpreferred = { reconnect: true, region: 'us-central1', regionCorrection: false, preferred: false }
    expect(plan).toHaveBeenNthCalledWith(1, expect.anything(), unpreferred)
    expect(plan).toHaveBeenNthCalledWith(2, expect.anything(), unpreferred)
    expect(plan).toHaveBeenNthCalledWith(3, expect.anything(), unpreferred)
  })

  it('does not count a migration report as a fallback', async () => {
    const recordRegionSelection = vi.fn()
    await assign(
      {
        recordRegionSelection,
        // A report carries no preference, so its target is the default region.
        resolve: vi.fn(async () => usAssignment({ cellId: 'asia-c1', region: 'asia-east2' })),
        exchangeRegionCorrection: vi.fn(async () => ({ v: 1, reportStatus: 'accepted' }))
      },
      {
        regionCorrection: {
          v: 1,
          action: 'report',
          generation: 2,
          assignmentEpoch: 3,
          policyVersion: 1,
          outcome: 'inconclusive',
          reason: 'timeout'
        }
      }
    )

    expect(recordRegionSelection).toHaveBeenCalledTimes(1)
    expect(recordRegionSelection.mock.calls[0]![0]).toMatchObject({ fallback: false })
  })
})

async function assign(
  operations: {
    recordRegionSelection: Mock
    recordAssignmentAdmission?: Mock
    plan?: Mock
    assign?: Mock
    resolve?: Mock
    exchangeRegionCorrection?: Mock
  },
  extra: Record<string, unknown> = {},
  overrides: Partial<RelayConfig> = {}
): Promise<Response> {
  const app = createRelayApp({ ...config(), ...overrides }, {
    store: {} as never,
    assignments: {
      assign: operations.assign ?? vi.fn(),
      resolve: operations.resolve ?? vi.fn(async () => null),
      exchangeRegionCorrection: operations.exchangeRegionCorrection ?? vi.fn()
    } as never,
    ...(operations.plan ? { reservePlacement: { plan: operations.plan } as never } : {}),
    drain: vi.fn(),
    ready: vi.fn(async () => true),
    recordRegionSelection: operations.recordRegionSelection,
    ...(operations.recordAssignmentAdmission
      ? { recordAssignmentAdmission: operations.recordAssignmentAdmission }
      : {})
  })
  return await app.request('/v1/assign', {
    method: 'POST',
    headers: { authorization: `Bearer ${HOST}`, 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, relayHostId: HOST, preferredRegion: 'asia-east2', ...extra })
  })
}

function config(): RelayConfig {
  return {
    port: 8080,
    publicUrl: 'https://relay.example.test',
    cellUrl: 'https://relay.example.test',
    region: 'us-central1',
    authIssuer: 'https://auth.example.test',
    authAudience: 'orca-relay',
    jwksUrl: 'https://auth.example.test/jwks',
    assignmentSigningKey: new TextEncoder().encode('assignment-key-with-at-least-32-bytes'),
    role: 'director',
    cellId: 'director',
    cells: [],
    adminAudience: 'https://relay.example.test/v1/admin/drain',
    deployServiceAccount: 'deploy@example.test',
    runtimeServiceAccount: 'runtime@example.test',
    adminJwksUrl: 'https://auth.example.test/jwks',
    databasePoolMax: 3,
    publicAssignmentsEnabled: true,
    regionalPlacementEnabled: true,
    publicAssignmentConcurrency: 2,
    publicAssignmentQueueMax: 128,
    publicAssignmentWaitMs: 4_000,
    publicResolveConcurrency: 1,
    publicResolveWaitMs: 5_000,
    publicAssignmentRetryAfterSeconds: 5,
    dataDir: './data'
  }
}
