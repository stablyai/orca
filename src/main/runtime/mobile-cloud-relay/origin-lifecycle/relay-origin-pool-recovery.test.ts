import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayHttpError, type RelayAssignment } from '../director/relay-http-client'
import type * as RelayHttpClient from '../director/relay-http-client'
import type { RelayControlOriginOptions } from './relay-control-origin-options'
import type { RelayOriginPoolOptions } from './relay-origin-pool-options'
import type { RelayControlOrigin } from './relay-control-origin'
import { RelayOriginPool } from './relay-origin-pool'

type FakeOrigin = {
  options: RelayControlOriginOptions
  cellUrl: string
  live: boolean
  closeNow: ReturnType<typeof vi.fn>
}

const harness = vi.hoisted(() => {
  const origins: FakeOrigin[] = []
  return { requestRelayAssignment: vi.fn(), origins, failConnects: false }
})

vi.mock('../director/relay-http-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RelayHttpClient>()),
  requestRelayAssignment: harness.requestRelayAssignment
}))
vi.mock('./relay-control-origin', () => ({
  RelayControlOrigin: class {
    readonly options: RelayControlOriginOptions
    assignment: RelayAssignment
    live = true
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
    hasLiveControl = (): boolean => this.live
    open = async (): Promise<void> => {
      if (harness.failConnects) {
        throw new Error('relay_control_connect_timeout')
      }
    }
    rebind = async (): Promise<void> => {
      if (harness.failConnects) {
        throw new Error('relay_control_connect_timeout')
      }
    }
    closeNow = vi.fn()
    refreshAuthorization = vi.fn()
    updateAssignment = vi.fn()
  }
}))

const edge: RelayAssignment = {
  v: 1,
  cellUrl: 'https://relay-edge.example',
  assignmentEpoch: 1,
  lease: 'l'
}
const hk: RelayAssignment = {
  v: 1,
  cellUrl: 'https://relay-hk.example',
  assignmentEpoch: 2,
  lease: 'l'
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pool created these fakes through the mocked RelayControlOrigin.
const asOrigin = (fake: FakeOrigin) => fake as unknown as RelayControlOrigin

async function openPool(): Promise<RelayOriginPool> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked origin reads no identity, keypair or wiring members.
  const options = {
    directorUrl: 'https://relay.example',
    relayHostId: 'host',
    isCurrent: () => true,
    onStatus: vi.fn(),
    random: () => 1
  } as unknown as RelayOriginPoolOptions
  const pool = new RelayOriginPool(options)
  await pool.openInitial(edge, 'relay-jwt')
  return pool
}

describe('RelayOriginPool recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    harness.origins.length = 0
    harness.failConnects = false
    harness.requestRelayAssignment.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('re-asks the director for a failing data path at most once a minute per host', async () => {
    harness.requestRelayAssignment.mockResolvedValue(edge)
    const pool = await openPool()
    const first = harness.origins[0]
    for (let i = 0; i < 6; i++) {
      first.options.onDataPathUnhealthy(asOrigin(first))
      await vi.advanceTimersByTimeAsync(10_000)
    }
    expect(harness.requestRelayAssignment).toHaveBeenCalledTimes(1)
    first.options.onDataPathUnhealthy(asOrigin(first))
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.requestRelayAssignment).toHaveBeenCalledTimes(2)
    pool.closeNow()
  })

  it('keeps the old cell for a minute when the director moves the host, so live phones finish', async () => {
    harness.requestRelayAssignment.mockResolvedValue(hk)
    const pool = await openPool()
    const first = harness.origins[0]
    // A live phone session is still spliced through the old origin.
    first.options.onConnectionOwned('conn-live', asOrigin(first))
    first.options.onDataPathUnhealthy(asOrigin(first))
    await vi.advanceTimersByTimeAsync(0)
    expect(pool.activeAssignment).toEqual(hk)
    await vi.advanceTimersByTimeAsync(59_000)
    expect(first.closeNow).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(first.closeNow).toHaveBeenCalled()
    pool.closeNow()
  })

  it('stops claiming recovery five minutes into a failing retry', async () => {
    harness.requestRelayAssignment.mockResolvedValue(edge)
    const pool = await openPool()
    harness.failConnects = true
    const first = harness.origins[0]
    first.live = false
    first.options.onClose(asOrigin(first), 1006)
    await vi.advanceTimersByTimeAsync(0)
    expect(pool.isRecovering()).toBe(true)
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(pool.isRecovering()).toBe(true)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(pool.isRecovering()).toBe(false)
    pool.closeNow()
  })

  it('stops claiming recovery at once when the director refuses the relay token', async () => {
    harness.requestRelayAssignment.mockRejectedValue(new RelayHttpError('assignment', 401))
    const pool = await openPool()
    const first = harness.origins[0]
    first.live = false
    first.options.onClose(asOrigin(first), 1006)
    await vi.advanceTimersByTimeAsync(0)
    expect(pool.isRecovering()).toBe(false)
    pool.closeNow()
  })
})
