import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dependencies,
  FakeLogicalClient,
  FakeRelaySession,
  FakeSession,
  host,
  relay
} from './mobile-endpoint-supervisor-test-fakes'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

const tailnetEndpoint = 'ws://100.120.233.23:6768/'

describe('Relay-owned LAN and Tailscale candidates', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-08T12:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('returns from Relay to LAN without opening a slower Tailscale socket', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const openDirect = vi.fn(() => new FakeSession('connected'))
    const openTailnetDirect = vi.fn(() => new FakeSession('connected'))
    const supervisor = new MobileEndpointSupervisor(
      logical,
      host.id,
      relay,
      dependencies({ openDirect, openTailnetDirect })
    )
    await supervisor.start()
    supervisor.learnTailnetEndpoint(tailnetEndpoint)
    await vi.advanceTimersByTimeAsync(65_000)

    expect(logical.getActivePath()).toBe('lan')
    expect(openDirect).toHaveBeenCalled()
    expect(openTailnetDirect).not.toHaveBeenCalled()
    supervisor.stop()
  })

  it('returns from Relay through Tailscale when the original LAN is unreachable', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const openDirect = vi.fn(() => new FakeSession('connecting'))
    const openTailnetDirect = vi.fn(() => new FakeSession('connected'))
    const supervisor = new MobileEndpointSupervisor(
      logical,
      host.id,
      relay,
      dependencies({ openDirect, openTailnetDirect })
    )
    await supervisor.start()
    supervisor.learnTailnetEndpoint(tailnetEndpoint)
    await vi.advanceTimersByTimeAsync(65_000)

    expect(openTailnetDirect).toHaveBeenCalledWith(tailnetEndpoint)
    expect(logical.getActivePath()).toBe('tailscale')
    expect(logical.getState()).toBe('connected')
    supervisor.stop()
  })

  it('keeps a healthy Relay while both direct candidates are unreachable', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const openDirect = vi.fn(() => new FakeSession('connecting'))
    const openTailnetDirect = vi.fn(() => new FakeSession('connecting'))
    const supervisor = new MobileEndpointSupervisor(
      logical,
      host.id,
      relay,
      dependencies({ openDirect, openTailnetDirect })
    )
    await supervisor.start()
    supervisor.learnTailnetEndpoint(tailnetEndpoint)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(openDirect).toHaveBeenCalled()
    expect(openTailnetDirect).toHaveBeenCalledWith(tailnetEndpoint)
    expect(logical.getActivePath()).toBe('relay')
    expect(logical.getState()).toBe('connected')
    expect(logical.migrateTo).not.toHaveBeenCalled()
    supervisor.stop()
  })

  it('recovers from LAN to Tailscale ahead of the Relay grace timer', async () => {
    const logical = new FakeLogicalClient('connected', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('connected'))
    const openTailnetDirect = vi.fn(() => new FakeSession('connected'))
    const supervisor = new MobileEndpointSupervisor(
      logical,
      host.id,
      relay,
      dependencies({ openRelay, openTailnetDirect })
    )
    await supervisor.start()
    supervisor.learnTailnetEndpoint(tailnetEndpoint)
    logical.publishState('reconnecting')
    logical.publishState('connecting')
    await vi.advanceTimersByTimeAsync(2_200)

    expect(logical.getActivePath()).toBe('tailscale')
    expect(logical.getState()).toBe('connected')
    expect(openRelay).not.toHaveBeenCalled()
    supervisor.stop()
  })

  it('still recovers through Relay when both direct paths cannot connect', async () => {
    const logical = new FakeLogicalClient('connected', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('connected'))
    const openTailnetDirect = vi.fn(() => new FakeSession('connecting'))
    const supervisor = new MobileEndpointSupervisor(
      logical,
      host.id,
      relay,
      dependencies({ openRelay, openTailnetDirect })
    )
    await supervisor.start()
    supervisor.learnTailnetEndpoint(tailnetEndpoint)
    logical.publishState('reconnecting')
    logical.publishState('connecting')
    await vi.advanceTimersByTimeAsync(4_000)

    expect(openTailnetDirect).toHaveBeenCalledWith(tailnetEndpoint)
    expect(openRelay).toHaveBeenCalled()
    expect(logical.getActivePath()).toBe('relay')
    expect(logical.getState()).toBe('connected')
    supervisor.stop()
  })

  it('promotes a healthy Tailscale session to LAN after Wi-Fi changes', async () => {
    const logical = new FakeLogicalClient('connected', 'tailscale')
    const readLocalNetwork = vi
      .fn()
      .mockResolvedValueOnce('wifi:10.0.1')
      .mockResolvedValue('wifi:192.168.1')
    const openDirect = vi.fn(() => new FakeSession('connected'))
    const supervisor = new MobileEndpointSupervisor(
      logical,
      host.id,
      relay,
      dependencies({ openDirect, readLocalNetwork })
    )
    await supervisor.start()
    await vi.advanceTimersByTimeAsync(0)
    supervisor.nudge('network-change')
    await vi.advanceTimersByTimeAsync(6_000)

    expect(logical.getActivePath()).toBe('lan')
    expect(openDirect).toHaveBeenCalled()
    supervisor.stop()
  })
})
