import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import {
  dependencies,
  FakeLogicalClient,
  FakeRelaySession,
  host,
  relay
} from './mobile-endpoint-supervisor-test-fakes'
import { ReplacementAuthenticationTimeoutError } from './replacement-session-authentication'
import type { RpcClient } from './rpc-client'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

// The 2026-09-03 incident: five consecutive "authentication timed out" dials against a
// live desktop while the cell's assignment tables were lock-contended. Each logged
// failure was two dials — the timeout counted as a director-class failure, so the phone
// re-resolved the same cell and waited the full bound again.
describe('relay dial against a cell that took the dial and stalled', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function timingOut(logical: FakeLogicalClient, error: Error): void {
    logical.migrateTo.mockImplementation(async (session: RpcClient) => {
      session.close()
      throw error
    })
  }

  it('does not re-resolve the director and names the stalled stage', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    timingOut(logical, new ReplacementAuthenticationTimeoutError('awaiting-hello', 30_000))
    const openRelay = vi.fn(() => new FakeRelaySession('connecting'))
    const resolveRelay = vi.fn(async () => relay)
    const onLog = vi.fn()
    const supervisor = new MobileEndpointSupervisor(
      logical,
      host,
      dependencies({ openRelay, resolveRelay, onLog })
    )

    await supervisor.start()

    expect(openRelay).toHaveBeenCalledOnce()
    expect(resolveRelay).not.toHaveBeenCalled()
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'relay-dial-failed',
        detail: expect.stringContaining('timed out (awaiting-hello, 30s)')
      })
    )
    supervisor.stop()
  })

  it('still re-resolves the director when the cell socket never opened', async () => {
    const logical = new FakeLogicalClient('disconnected', 'lan')
    timingOut(logical, new ReplacementAuthenticationTimeoutError('opening', 12_000))
    const openRelay = vi.fn(() => new FakeRelaySession('connecting'))
    const resolveRelay = vi.fn(async () => relay)
    const supervisor = new MobileEndpointSupervisor(
      logical,
      host,
      dependencies({ openRelay, resolveRelay })
    )

    await supervisor.start()

    expect(resolveRelay).toHaveBeenCalledOnce()
    expect(openRelay).toHaveBeenCalledTimes(2)
    supervisor.stop()
  })
})
