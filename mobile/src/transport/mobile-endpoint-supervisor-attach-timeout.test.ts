import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_RELAY_PHONE_CLOSE_REASON } from '../../../src/shared/mobile-relay-close-codes'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import {
  dependencies,
  FakeLogicalClient,
  FakeRelaySession,
  host,
  relay
} from './mobile-endpoint-supervisor-test-fakes'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor'
import type { RpcClient } from './rpc-client'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

const HOST_OFFLINE_WAIT_MS = 5_039
const ATTACH_TIMEOUT_REDIAL_MS = 1_003

function attachTimeout(): RelayOuterError {
  return new RelayOuterError(4404, true, MOBILE_RELAY_PHONE_CLOSE_REASON.HOST_ATTACH_TIMEOUT)
}

function cellRefusing(failure: () => Error, succeedAfter = Number.POSITIVE_INFINITY) {
  const logical = new FakeLogicalClient('disconnected', 'lan')
  const migrateTo = logical.migrateTo.getMockImplementation()!
  let dials = 0
  logical.migrateTo.mockImplementation(async (session: RpcClient, ...rest) => {
    dials += 1
    if (dials > succeedAfter) {
      return migrateTo(session, ...rest)
    }
    session.close()
    throw failure()
  })
  const openRelay = vi.fn<MobileEndpointSupervisorDependencies['openRelay']>(
    () => new FakeRelaySession('connected')
  )
  return { logical, openRelay }
}

function start(
  logical: FakeLogicalClient,
  overrides: Partial<MobileEndpointSupervisorDependencies>
): MobileEndpointSupervisor {
  const supervisor = new MobileEndpointSupervisor(
    logical,
    host.id,
    relay,
    dependencies({
      // Why: a reachable direct path would win and end relay recovery mid-test.
      openDirect: vi.fn(() => new FakeRelaySession('disconnected')),
      ...overrides
    })
  )
  return supervisor
}

describe('relay dial refused because the desktop data link missed its attach deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('redials the same cell after a short delay without asking the director', async () => {
    const { logical, openRelay } = cellRefusing(attachTimeout, 1)
    const resolveRelay = vi.fn(async () => relay)
    const supervisor = start(logical, { openRelay, resolveRelay })

    await supervisor.start()
    expect(openRelay).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(ATTACH_TIMEOUT_REDIAL_MS - 1)
    expect(openRelay).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)

    expect(openRelay).toHaveBeenCalledTimes(2)
    expect(openRelay.mock.calls[1]?.[0].cellUrl).toBe(relay.cellUrl)
    expect(resolveRelay).not.toHaveBeenCalled()
    expect(logical.getState()).toBe('connected')
    supervisor.stop()
  })

  it('falls back to the known-offline wait when the redial fails the same way', async () => {
    const { logical, openRelay } = cellRefusing(attachTimeout)
    const resolveRelay = vi.fn(async () => relay)
    const supervisor = start(logical, { openRelay, resolveRelay })

    await supervisor.start()
    await vi.advanceTimersByTimeAsync(ATTACH_TIMEOUT_REDIAL_MS)
    expect(openRelay).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(HOST_OFFLINE_WAIT_MS - 1)
    expect(openRelay).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(openRelay).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(HOST_OFFLINE_WAIT_MS - 1)
    expect(openRelay).toHaveBeenCalledTimes(3)
    expect(resolveRelay).not.toHaveBeenCalled()
    supervisor.stop()
  })

  it('keeps the known-offline wait for a 4404 without the reason', async () => {
    const { logical, openRelay } = cellRefusing(() => new RelayOuterError(4404, true))
    const resolveRelay = vi.fn(async () => relay)
    const supervisor = start(logical, { openRelay, resolveRelay })

    await supervisor.start()

    expect(resolveRelay).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(HOST_OFFLINE_WAIT_MS - 1)
    expect(openRelay).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(openRelay).toHaveBeenCalledTimes(2)
    supervisor.stop()
  })

  it('earns a fresh quick redial when the app returns to the foreground', async () => {
    const { logical, openRelay } = cellRefusing(attachTimeout)
    const supervisor = start(logical, { openRelay })
    await supervisor.start()
    await vi.advanceTimersByTimeAsync(ATTACH_TIMEOUT_REDIAL_MS)
    expect(openRelay).toHaveBeenCalledTimes(2)

    supervisor.setForeground(false)
    supervisor.setForeground(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(openRelay).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(ATTACH_TIMEOUT_REDIAL_MS)

    expect(openRelay).toHaveBeenCalledTimes(4)
    supervisor.stop()
  })
})
