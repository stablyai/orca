import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dependencies,
  FakeLogicalClient,
  FakeRelaySession,
  FakeSession,
  host
} from './mobile-endpoint-supervisor-test-fakes'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

describe('mobile Relay background lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'))
  })

  afterEach(() => vi.useRealTimers())

  it('retains a relay session across a quick background and foreground', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    supervisor.setForeground(false)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(logical.suspendActiveSession).not.toHaveBeenCalled()
    expect(logical.getState()).toBe('connected')

    supervisor.setForeground(true)
    await vi.advanceTimersByTimeAsync(1)

    expect(logical.suspendActiveSession).not.toHaveBeenCalled()
    expect(deps.openRelay).not.toHaveBeenCalled()
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('releases a retained relay after 30 seconds and recovers only on foreground', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    supervisor.setForeground(false)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(logical.suspendActiveSession).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(logical.suspendActiveSession).toHaveBeenCalledOnce()
    expect(logical.getState()).toBe('disconnected')
    expect(deps.openRelay).not.toHaveBeenCalled()

    supervisor.setForeground(true)
    await vi.waitFor(() => expect(logical.migrateTo).toHaveBeenCalledOnce())
    expect(logical.getActivePath()).toBe('relay')
    supervisor.stop()
  })

  it('enforces an overdue grace on foreground when the background timer was suspended', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    supervisor.setForeground(false)
    vi.setSystemTime(Date.now() + 30_000)
    expect(logical.suspendActiveSession).not.toHaveBeenCalled()

    supervisor.setForeground(true)
    expect(logical.suspendActiveSession).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(deps.openRelay).toHaveBeenCalledOnce())
    expect(logical.getState()).toBe('connected')
    supervisor.stop()
  })

  it('recovers after a retained relay fails while backgrounded', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    supervisor.setForeground(false)
    await vi.advanceTimersByTimeAsync(5_000)
    logical.publishState('disconnected')

    expect(logical.suspendActiveSession).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    expect(deps.openRelay).not.toHaveBeenCalled()

    supervisor.setForeground(true)
    await vi.waitFor(() => expect(deps.openRelay).toHaveBeenCalledOnce())
    expect(logical.getState()).toBe('connected')
    supervisor.stop()
  })

  it('does not retain or suspend a healthy direct session in the background', async () => {
    const logical = new FakeLogicalClient('connected', 'tailscale')
    const deps = dependencies()
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    supervisor.setForeground(false)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(logical.suspendActiveSession).not.toHaveBeenCalled()
    expect(logical.getState()).toBe('connected')
    expect(deps.openRelay).not.toHaveBeenCalled()
    supervisor.stop()
  })

  it('resumes a lease rotation that came due during the background grace', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('connected', null, Date.now() + 90_000))
    const deps = dependencies({
      openDirect: vi.fn(() => new FakeSession('disconnected')),
      openRelay
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    await supervisor.start()

    await vi.advanceTimersByTimeAsync(40_000)
    supervisor.setForeground(false)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(openRelay).toHaveBeenCalledOnce()
    expect(logical.getState()).toBe('connected')

    supervisor.setForeground(true)
    await vi.waitFor(() => expect(openRelay).toHaveBeenCalledTimes(2))
    expect(logical.getState()).toBe('connected')
    supervisor.stop()
  })

  it('arms lease rotation when confirmation persistence finishes during the grace', async () => {
    let finishWrite: (() => void) | null = null
    const writeStarted = new Promise<void>((resolve) => {
      finishWrite = resolve
    })
    const logical = new FakeLogicalClient('disconnected', 'lan')
    const openRelay = vi.fn(() => new FakeRelaySession('connected', null, Date.now() + 90_000))
    const deps = dependencies({
      openDirect: vi.fn(() => new FakeSession('disconnected')),
      openRelay,
      writeBundle: vi.fn(() => writeStarted)
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    const starting = supervisor.start()
    await vi.waitFor(() => expect(deps.writeBundle).toHaveBeenCalledOnce())

    supervisor.setForeground(false)
    finishWrite?.()
    await starting
    supervisor.setForeground(true)
    await vi.advanceTimersByTimeAsync(60_000)

    await vi.waitFor(() => expect(openRelay).toHaveBeenCalledTimes(2))
    expect(logical.getState()).toBe('connected')
    supervisor.stop()
  })
})
