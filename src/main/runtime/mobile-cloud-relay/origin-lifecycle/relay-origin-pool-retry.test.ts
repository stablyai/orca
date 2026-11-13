import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayHttpError, type RelayAssignment } from '../director/relay-http-client'
import type * as RelayHttpClient from '../director/relay-http-client'
import type { RelayControlOriginOptions } from './relay-control-origin-options'
import type { RelayOriginPoolOptions } from './relay-origin-pool-options'
import { RelayOriginPool } from './relay-origin-pool'
import type { RelayControlOrigin } from './relay-control-origin'

type FakeOrigin = { options: RelayControlOriginOptions }

const harness = vi.hoisted(() => {
  const origins: FakeOrigin[] = []
  return { requestRelayAssignment: vi.fn(), origins, failOpens: false }
})

vi.mock('../director/relay-http-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RelayHttpClient>()),
  requestRelayAssignment: harness.requestRelayAssignment
}))
vi.mock('./relay-control-origin', () => ({
  RelayControlOrigin: class {
    readonly options: RelayControlOriginOptions
    readonly failOpen = harness.failOpens
    assignment: RelayAssignment
    availableControl = null
    pendingRequestCount = 0
    controlLeaseExpiresAt = Date.now() + 6 * 60 * 60_000
    constructor(options: RelayControlOriginOptions) {
      this.options = options
      this.assignment = options.assignment
      harness.origins.push(this)
    }
    get cellUrl(): string {
      return this.assignment.cellUrl
    }
    hasLiveControl = (): boolean => !this.failOpen
    open = async (): Promise<void> => {
      if (this.failOpen) {
        throw new Error('relay_control_connect_timeout')
      }
    }
    rebind = async (): Promise<void> => {
      throw new Error('relay_control_connect_timeout')
    }
    closeNow = vi.fn()
    refreshAuthorization = vi.fn()
    updateAssignment = vi.fn()
  }
}))

const assignment: RelayAssignment = {
  v: 1,
  cellUrl: 'https://relay-edge.example',
  assignmentEpoch: 1,
  lease: 'lease'
}

async function poolWithDeadControl(ask: () => Promise<RelayAssignment>) {
  const askedAt: number[] = []
  harness.requestRelayAssignment.mockImplementation(async () => {
    askedAt.push(Date.now())
    return ask()
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked origin reads no identity, keypair or wiring members.
  const options = {
    directorUrl: 'https://relay.example',
    relayHostId: 'host',
    isCurrent: () => true,
    onStatus: vi.fn(),
    random: () => 1
  } as unknown as RelayOriginPoolOptions
  const pool = new RelayOriginPool(options)
  await pool.openInitial(assignment, 'relay-jwt')
  // Every later connect to the cell fails, as from a network that cannot hold it.
  harness.failOpens = true
  const first = harness.origins[0]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pool created this fake through the mocked RelayControlOrigin.
  first.options.onClose(first as unknown as RelayControlOrigin, 1006)
  // With random() = 1 every backoff waits its full cap, so the gaps between asks show the cap.
  const gapsBetweenAsks = async (count: number): Promise<number[]> => {
    while (askedAt.length < count) {
      await vi.advanceTimersByTimeAsync(1_000)
    }
    return askedAt.slice(1).map((at, index) => at - askedAt[index])
  }
  return { pool, gapsBetweenAsks }
}

describe('RelayOriginPool drain retry cap', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    harness.origins.length = 0
    harness.failOpens = false
    harness.requestRelayAssignment.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('caps the retry at 60s when the director answered and only the cell connect failed', async () => {
    const { pool, gapsBetweenAsks } = await poolWithDeadControl(async () => assignment)
    const gaps = await gapsBetweenAsks(10)
    // 1, 2, 4 ... 32s, then 60s instead of doubling on to 300s.
    expect(Math.max(...gaps)).toBeLessThanOrEqual(61_000)
    expect(gaps.slice(-3).every((gap) => gap >= 60_000)).toBe(true)
    pool.closeNow()
  })

  it('keeps the full backoff while the director itself is failing', async () => {
    const { pool, gapsBetweenAsks } = await poolWithDeadControl(async () => {
      throw new RelayHttpError('assignment', 503)
    })
    const gaps = await gapsBetweenAsks(10)
    expect(Math.max(...gaps)).toBeGreaterThan(250_000)
    pool.closeNow()
  })
})
