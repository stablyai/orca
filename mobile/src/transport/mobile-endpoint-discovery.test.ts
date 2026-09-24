import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import {
  dependencies,
  FakeLogicalClient,
  FakeSession,
  host
} from './mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from './types'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

const office = 'ws://10.20.30.40:6768'
const cafe = 'ws://192.168.50.60:6769'
const reply = (urls: string[]): RpcResponse => ({
  id: 'discovery',
  ok: true,
  result: { v: 1, endpoints: urls.map((url) => ({ kind: 'lan', url })) }
})

describe('returning from relay after the desktop changes LAN', () => {
  const supervisors: MobileEndpointSupervisor[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    supervisors.splice(0).forEach((s) => s.stop())
    vi.useRealTimers()
  })

  async function start(
    logical: FakeLogicalClient,
    openDirect = vi.fn(() => new FakeSession('connected'))
  ) {
    const deps = dependencies({ openDirect })
    const supervisor = new MobileEndpointSupervisor(logical, host, deps)
    supervisors.push(supervisor)
    await supervisor.start()
    return { supervisor, deps }
  }

  it('probes the current LAN address and retains the existing promotion dwell', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    logical.sendRequest.mockResolvedValue(reply([office]))
    const { deps } = await start(logical)

    await vi.advanceTimersByTimeAsync(15_000)
    expect(logical.sendRequest).toHaveBeenCalledWith(
      'pairing.getDirectEndpoints',
      {},
      {
      timeoutMs: 5000,
        budgetSpansConnect: true,
        failWhenDisconnected: true
      }
    )
    expect(deps.openDirect).toHaveBeenCalledWith(office)
    expect(deps.openDirect).not.toHaveBeenCalledWith(host.endpoint)
    expect(logical.migrateTo).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(45_000)
    expect(logical.getActivePath()).toBe('lan')
    expect(deps.saveHost).not.toHaveBeenCalled()
  })

  it('replaces a previous network snapshot instead of accumulating old LANs', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    logical.sendRequest.mockResolvedValue(reply([office]))
    const { deps } = await start(logical)
    await vi.advanceTimersByTimeAsync(15_000)
    vi.mocked(deps.openDirect).mockClear()
    logical.sendRequest.mockResolvedValue(reply([cafe]))

    await vi.advanceTimersByTimeAsync(15_000)
    expect(deps.openDirect).toHaveBeenCalledExactlyOnceWith(cafe)
  })

  it.each(['forbidden', 'method_not_found'])(
    'keeps pair-time candidates on an old host returning %s',
    async (code) => {
      const logical = new FakeLogicalClient('connected', 'relay')
      logical.sendRequest.mockResolvedValue({
        id: 'discovery',
        ok: false,
        error: { code, message: code }
      })
      const { deps } = await start(logical)
      await vi.advanceTimersByTimeAsync(15_000)
      expect(deps.openDirect).toHaveBeenCalledWith(host.endpoint)
      expect(logical.getState()).toBe('connected')
    }
  )

  it('does not dial loopback or malformed candidates returned by a peer', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    logical.sendRequest.mockResolvedValue(reply(['ws://127.0.0.1:6768']))
    const { deps } = await start(logical)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(deps.openDirect).not.toHaveBeenCalledWith('ws://127.0.0.1:6768')
    expect(deps.openDirect).toHaveBeenCalledWith(host.endpoint)
  })

  it('withdraws learned addresses when the host reports no direct listener', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    logical.sendRequest.mockResolvedValue(reply([office]))
    const { deps } = await start(logical)
    await vi.advanceTimersByTimeAsync(15_000)
    vi.mocked(deps.openDirect).mockClear()
    logical.sendRequest.mockResolvedValue(reply([]))

    await vi.advanceTimersByTimeAsync(30_000)
    expect(deps.openDirect).not.toHaveBeenCalled()
    expect(logical.getActivePath()).toBe('relay')
  })

  it('does not open a socket when discovery finishes after the owner stops', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    let finish: ((response: RpcResponse) => void) | undefined
    logical.sendRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const { deps, supervisor } = await start(logical)
    await vi.advanceTimersByTimeAsync(15_000)
    supervisor.stop()
    finish?.(reply([office]))
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.openDirect).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('observes the new network afresh before promoting it', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    logical.sendRequest.mockResolvedValue(reply([office]))
    await start(logical)
    await vi.advanceTimersByTimeAsync(45_000)
    logical.sendRequest.mockResolvedValue(reply([cafe]))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(logical.migrateTo).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(logical.getActivePath()).toBe('lan')
  })

  it('accepts additive reply fields and an unfamiliar direct interface kind', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    logical.sendRequest.mockResolvedValue({
      id: 'discovery',
      ok: true,
      result: { v: 1, refreshedAt: 1, endpoints: [{ kind: 'ethernet', url: cafe, priority: 1 }] }
    })
    const { deps } = await start(logical)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(deps.openDirect).toHaveBeenCalledWith(cafe)
  })

  it('keeps the working relay when the discovered address fails authentication', async () => {
    const logical = new FakeLogicalClient('connected', 'relay')
    logical.sendRequest.mockResolvedValue(reply([office]))
    const rejected = new FakeSession('auth-failed')
    await start(
      logical,
      vi.fn(() => rejected)
    )
    await vi.advanceTimersByTimeAsync(120_000)
    expect(rejected.close).toHaveBeenCalled()
    expect(logical.migrateTo).not.toHaveBeenCalled()
    expect(logical.getState()).toBe('connected')
  })
})
