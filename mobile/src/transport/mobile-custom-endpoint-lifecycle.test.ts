import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startMobileEndpointLifecycle } from './mobile-endpoint-lifecycle'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'
import { FakeSession } from './mobile-endpoint-supervisor-test-fakes'
import { connect } from './rpc-client'
import type { HostProfile, RpcResponse } from './types'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))
vi.mock('./rpc-client', () => ({ connect: vi.fn() }))
vi.mock('./mobile-relay-direct-upgrade', () => ({
  upgradeDirectMobileRelay: vi.fn(async () => null)
}))

const endpoint = 'wss://remote.example.test/orca'
const lan = 'ws://192.168.50.20:6768'
const host: HostProfile = {
  id: 'custom-host',
  name: 'Desktop',
  endpoint,
  deviceToken: 'paired-device-token',
  publicKeyB64: 'A'.repeat(44),
  lastConnected: 0
}
const discovered: RpcResponse = {
  id: 'discovery',
  ok: true,
  result: { v: 1, endpoints: [{ kind: 'lan', url: lan }] }
}

describe('LAN roaming through a custom WebSocket endpoint', () => {
  const cleanup: (() => void)[] = []
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.clearAllMocks()
  })
  afterEach(() => {
    cleanup.splice(0).forEach((close) => close())
    vi.useRealTimers()
  })

  function start() {
    const remote = new FakeSession('connected')
    remote.sendRequest.mockResolvedValue(discovered)
    const logical = createStableLogicalRpcClient(remote, 'lan')
    const candidates: FakeSession[] = []
    vi.mocked(connect).mockImplementation(() => {
      const session = new FakeSession('connected')
      session.sendRequest.mockResolvedValue(discovered)
      candidates.push(session)
      return session
    })
    const lifecycle = startMobileEndpointLifecycle(logical, host, vi.fn())
    cleanup.push(() => {
      lifecycle.stop()
      logical.close()
    })
    return { remote, logical, lifecycle, candidates }
  }

  it('authenticates LAN with the paired identity and carries subscriptions across both directions', async () => {
    const { logical, remote, candidates } = start()
    logical.subscribe('terminal.subscribe', { terminal: 'terminal-1' }, vi.fn())
    await vi.advanceTimersByTimeAsync(60_000)
    expect(connect).toHaveBeenLastCalledWith(
      lan,
      host.deviceToken,
      host.publicKeyB64,
      expect.anything()
    )
    expect(logical.getGeneration()).toBe(2)
    expect(remote.close).toHaveBeenCalledOnce()
    const preferred = candidates.at(-1)!
    expect(preferred.subscribe).toHaveBeenCalledOnce()

    preferred.publishState('reconnecting')
    await vi.advanceTimersByTimeAsync(0)
    expect(connect).toHaveBeenLastCalledWith(
      endpoint,
      host.deviceToken,
      host.publicKeyB64,
      expect.anything()
    )
    expect(logical.getGeneration()).toBe(3)
    expect(candidates.at(-1)!.subscribe).toHaveBeenCalledOnce()
    expect(host.endpoint).toBe(endpoint)
  })

  it('does not repeatedly replace a healthy LAN session', async () => {
    const { logical } = start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(logical.getGeneration()).toBe(2)
    const calls = vi.mocked(connect).mock.calls.length
    await vi.advanceTimersByTimeAsync(300_000)
    expect(connect).toHaveBeenCalledTimes(calls)
    expect(logical.getGeneration()).toBe(2)
  })

  it('learns a different LAN after falling back through the original endpoint', async () => {
    const { logical, candidates } = start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(logical.getGeneration()).toBe(2)
    candidates.at(-1)!.publishState('disconnected')
    await vi.advanceTimersByTimeAsync(0)
    const nextLan = 'ws://10.20.30.40:6769'
    candidates.at(-1)!.sendRequest.mockResolvedValue({
      id: 'discovery',
      ok: true,
      result: { v: 1, endpoints: [{ kind: 'lan', url: nextLan }] }
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(connect).toHaveBeenLastCalledWith(
      nextLan,
      host.deviceToken,
      host.publicKeyB64,
      expect.anything()
    )
    expect(logical.getGeneration()).toBe(4)
  })

  it('keeps the remote session if a candidate drops between probing and migration', async () => {
    const { remote, logical, candidates } = start()
    const migrate = logical.migrateTo.bind(logical)
    vi.spyOn(logical, 'migrateTo').mockImplementationOnce(async (session, ...args) => {
      candidates.at(-1)!.publishState('disconnected')
      await migrate(session, ...args)
    })
    await vi.advanceTimersByTimeAsync(72_000)
    expect(logical.getState()).toBe('connected')
    expect(logical.getGeneration()).toBe(1)
    expect(remote.close).not.toHaveBeenCalled()
    expect(candidates.at(-1)!.close).toHaveBeenCalled()
  })

  it.each(['forbidden', 'method_not_found'])(
    'leaves an older host alone when discovery returns %s',
    async (code) => {
      const { remote, logical } = start()
      remote.sendRequest.mockResolvedValue({
        id: 'discovery',
        ok: false,
        error: { code, message: code }
      })
      await vi.advanceTimersByTimeAsync(120_000)
      expect(connect).not.toHaveBeenCalled()
      expect(logical.getState()).toBe('connected')
      expect(remote.close).not.toHaveBeenCalled()
    }
  )

  it('only resumes LAN failure recovery when the app is foregrounded', async () => {
    const { lifecycle, candidates, logical } = start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(logical.getGeneration()).toBe(2)
    lifecycle.setForeground(false)
    vi.mocked(connect).mockClear()
    candidates.at(-1)!.publishState('reconnecting')
    lifecycle.nudge('network-change')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(connect).not.toHaveBeenCalled()
    lifecycle.setForeground(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(connect).toHaveBeenCalledWith(
      endpoint,
      host.deviceToken,
      host.publicKeyB64,
      expect.anything()
    )
  })

  it('cancels discovery on background and ignores a late address response', async () => {
    const { lifecycle, remote, logical } = start()
    let resolveDiscovery: (response: RpcResponse) => void = () => {}
    remote.sendRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDiscovery = resolve
        })
    )
    await vi.advanceTimersByTimeAsync(15_000)
    lifecycle.setForeground(false)
    resolveDiscovery(discovered)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(connect).not.toHaveBeenCalled()
    expect(remote.close).not.toHaveBeenCalled()
    expect(logical.getGeneration()).toBe(1)
    lifecycle.setForeground(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(logical.getGeneration()).toBe(2)
  })

  it('closes a pending LAN dial on background without replacing the remote session', async () => {
    const { lifecycle, remote, logical } = start()
    const candidate = new FakeSession('connecting')
    vi.mocked(connect).mockReturnValue(candidate)
    await vi.advanceTimersByTimeAsync(15_000)
    lifecycle.setForeground(false)
    candidate.publishState('connected')
    await vi.advanceTimersByTimeAsync(0)
    expect(candidate.close).toHaveBeenCalledOnce()
    expect(remote.close).not.toHaveBeenCalled()
    expect(logical.getGeneration()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fences a LAN cutover when backgrounding races migration', async () => {
    const { lifecycle, remote, logical, candidates } = start()
    const migrate = logical.migrateTo.bind(logical)
    vi.spyOn(logical, 'migrateTo').mockImplementationOnce(async (...args) => {
      lifecycle.setForeground(false)
      await migrate(...args)
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(logical.getGeneration()).toBe(1)
    expect(remote.close).not.toHaveBeenCalled()
    expect(candidates.at(-1)!.close).toHaveBeenCalled()
    lifecycle.setForeground(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(logical.getGeneration()).toBe(2)
  })

  it('cancels a pending fallback dial when the host is removed', async () => {
    const { lifecycle, candidates, logical } = start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(logical.getGeneration()).toBe(2)
    const pending = new FakeSession('connecting')
    vi.mocked(connect).mockReturnValue(pending)
    candidates.at(-1)!.publishState('reconnecting')
    await vi.advanceTimersByTimeAsync(0)
    lifecycle.stop()
    await vi.advanceTimersByTimeAsync(0)
    expect(pending.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    pending.publishState('connected')
    await vi.advanceTimersByTimeAsync(0)
    expect(logical.getGeneration()).toBe(2)
  })

  it('paces failed fallback dials and keeps a LAN session that recovers during the dial', async () => {
    const { candidates, logical, lifecycle } = start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(logical.getGeneration()).toBe(2)
    const preferred = candidates.at(-1)!
    const pending = new FakeSession('connecting')
    vi.mocked(connect).mockClear().mockReturnValue(pending)
    preferred.publishState('reconnecting')
    await vi.advanceTimersByTimeAsync(0)
    preferred.publishState('connected')
    pending.publishState('connected')
    await vi.advanceTimersByTimeAsync(0)
    expect(logical.getGeneration()).toBe(2)
    expect(pending.close).toHaveBeenCalledOnce()

    const failed = new FakeSession('connecting')
    vi.mocked(connect).mockReturnValue(failed)
    preferred.publishState('reconnecting')
    await vi.advanceTimersByTimeAsync(0)
    failed.publishState('auth-failed')
    await vi.advanceTimersByTimeAsync(0)
    const calls = vi.mocked(connect).mock.calls.length
    for (let i = 0; i < 10; i++) {
      lifecycle.nudge('network-change')
    }
    await vi.advanceTimersByTimeAsync(14_999)
    expect(connect).toHaveBeenCalledTimes(calls)
    await vi.advanceTimersByTimeAsync(1)
    expect(connect).toHaveBeenCalledTimes(calls + 1)
  })
})
