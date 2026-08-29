import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyConnection } from './connection-health'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import {
  dependencies,
  FakeRelaySession,
  FakeSession,
  host
} from './mobile-endpoint-supervisor-test-fakes'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

describe('continuous Relay outage escalation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-17T04:00:00Z'))
  })

  afterEach(() => vi.useRealTimers())

  it('publishes supervisor recovery attempts and escalates the Relay verdict', async () => {
    const failure = new RelayOuterError(4408)
    const activeRelay = new FakeRelaySession('connected', failure)
    activeRelay.getLastConnectedAt = () => Date.now() - 120_000
    const logical = createStableLogicalRpcClient(new FakeSession('disconnected'), 'tailscale')
    const publishedAttempts: number[] = []
    logical.onConnectionPathChange(() => publishedAttempts.push(logical.getReconnectAttempt()))
    const openRelay = vi.fn(() => {
      const session = new FakeRelaySession('connecting', failure)
      setTimeout(() => session.publishState('disconnected'), 0)
      return session
    })
    openRelay.mockReturnValueOnce(activeRelay)
    const deps = dependencies({
      openDirect: vi.fn(() => new FakeSession('disconnected')),
      openRelay,
      randomBytes: () => new Uint8Array([0, 0])
    })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)

    await supervisor.start()
    expect(openRelay).toHaveBeenCalledOnce()
    expect(logical.getActivePath()).toBe('relay')
    activeRelay.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(3_000)

    expect(openRelay).toHaveBeenCalledTimes(12)
    expect(logical.getPendingPath()).toBe('relay')
    expect(logical.getReconnectAttempt()).toBe(12)
    expect(publishedAttempts.at(-1)).toBe(12)
    expect(
      classifyConnection({
        state: logical.getState(),
        reconnectAttempts: logical.getReconnectAttempt(),
        lastConnectedAt: logical.getLastConnectedAt(),
        pendingPath: logical.getPendingPath()
      })
    ).toMatchObject({ kind: 'unreachable', label: "Can't connect via Relay" })
    supervisor.stop()
    logical.close()
  })
})
