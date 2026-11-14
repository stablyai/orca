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

  const THIRTY_MINUTES = 30 * 60_000

  async function asksDuring(ms: number, ask: () => Promise<RelayAssignment>): Promise<number[]> {
    const { pool, gapsBetweenAsks } = await poolWithDeadControl(ask)
    await vi.advanceTimersByTimeAsync(ms)
    const gaps = await gapsBetweenAsks(0)
    pool.closeNow()
    return gaps
  }

  it('asks the director no more often than the full backoff while it keeps naming a dead cell', async () => {
    const deadCell = await asksDuring(THIRTY_MINUTES, async () => assignment)
    harness.origins.length = 0
    harness.failOpens = false
    const directorDown = await asksDuring(THIRTY_MINUTES, async () => {
      throw new RelayHttpError('assignment', 503)
    })
    expect(deadCell.length).toBeLessThanOrEqual(directorDown.length)
    // Backoff reaches the 300s cap, not 60s.
    expect(Math.max(...deadCell)).toBeGreaterThan(250_000)
  })

  it('falls back to the full backoff when the director alternates between failing cells', async () => {
    const deadCell = await asksDuring(THIRTY_MINUTES, async () => assignment)
    harness.origins.length = 0
    harness.failOpens = false
    let epoch = 1
    const alternating = await asksDuring(THIRTY_MINUTES, async () => {
      epoch += 1
      const cell = epoch % 2 === 0 ? 'a' : 'b'
      return { ...assignment, cellUrl: `https://relay-${cell}.example`, assignmentEpoch: epoch }
    })
    // Each of the two cells gets the short cap once; after that the rate matches a dead cell.
    expect(alternating.length).toBeLessThanOrEqual(deadCell.length + 2)
    expect(Math.max(...alternating)).toBeGreaterThan(250_000)
  })

  it('retries within 60s each time the director names a different cell that then fails', async () => {
    let epoch = 1
    const gaps = await asksDuring(THIRTY_MINUTES, async () => {
      epoch += 1
      return { ...assignment, cellUrl: `https://relay-c${epoch}.example`, assignmentEpoch: epoch }
    })
    expect(gaps.length).toBeGreaterThan(25)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(61_000)
  })

  it('keeps the full backoff while the director itself is failing', async () => {
    const gaps = await asksDuring(THIRTY_MINUTES, async () => {
      throw new RelayHttpError('assignment', 503)
    })
    expect(Math.max(...gaps)).toBeGreaterThan(250_000)
  })
})
