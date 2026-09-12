import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConnectionLogStore } from './connection-log-buffer'
import { HostClientOpenRegistry } from './host-client-open-registry'
import { HostOpenRetryScheduler } from './host-open-retry-scheduler'
import { openHostClientEntry, type HostClientStoreEntry } from './host-entry-opener'
import { MobileEndpointSupervisor } from './mobile-endpoint-supervisor'
import { dependencies, FakeLogicalClient, host } from './mobile-endpoint-supervisor-test-fakes'
import type { ConnectionLogEntry, ConnectionLogSink } from './types'
import type { RpcClient } from './rpc-client'

const mocks = vi.hoisted(() => ({ open: vi.fn(), append: vi.fn() }))
vi.mock('../notifications/push-registration', () => ({ attachPushRegistration: () => () => {} }))
vi.mock('./host-logical-client', () => ({
  openHostLogicalClient: (...args: unknown[]) => mocks.open(...args)
}))
vi.mock('./host-store', () => ({ loadHosts: async () => [] }))
vi.mock('./persisted-connection-log-store', () => ({
  connectionLogStore: { append: (...args: unknown[]) => mocks.append(...args) },
  recordConnectionClientSessionStart: () => {}
}))
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

const event = (id: string): ConnectionLogEntry => ({ id, ts: 1, level: 'info', message: id })

function createHarness() {
  const logs = createConnectionLogStore()
  mocks.append.mockImplementation((id: string, entry: ConnectionLogEntry) => logs.append(id, entry))
  const pendingOpens = new HostClientOpenRegistry()
  const state = {
    store: new Map<string, HostClientStoreEntry>(),
    pendingOpens,
    pendingAcquisitions: new Map([[host.id, 1]]),
    primedHosts: new Map([[host.id, host]]),
    retryScheduler: new HostOpenRetryScheduler({ canRetry: () => false, open: () => {} }),
    notifyHostState: () => {},
    notifyAllHosts: () => {}
  }
  return {
    logs,
    state,
    retire: async () => {
      pendingOpens.cancel(host.id)
      state.store.get(host.id)?.client.close()
      state.store.delete(host.id)
      await logs.forgetHost(host.id)
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.open.mockReset()
  mocks.append.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('host-client diagnostic producer retirement', () => {
  it('keeps startup and current-client diagnostics after opener settlement', async () => {
    const { state, logs } = createHarness()
    let sink!: ConnectionLogSink
    mocks.open.mockImplementation((_host, onLog: ConnectionLogSink) => {
      sink = onLog
      sink(event('startup'))
      return new FakeLogicalClient('connected', 'lan')
    })
    await openHostClientEntry(state, host.id)
    sink(event('current'))
    expect(logs.get(host.id).map(({ id }) => id)).toEqual(['startup', 'current'])
  })

  it('rejects the retired client after the same host id is re-paired', async () => {
    const { state, logs, retire } = createHarness()
    const sinks: ConnectionLogSink[] = []
    mocks.open.mockImplementation((_host, onLog: ConnectionLogSink) => {
      sinks.push(onLog)
      return new FakeLogicalClient('connected', 'lan')
    })
    await openHostClientEntry(state, host.id)
    await retire()
    state.pendingAcquisitions.set(host.id, 1)
    await openHostClientEntry(state, host.id)
    sinks[1](event('new-client'))
    sinks[0](event('retired-client'))
    expect(logs.get(host.id).map(({ id }) => id)).toEqual(['new-client'])
  })

  it('cannot recreate a removed log when a real supervisor credential read completes late', async () => {
    const { state, logs, retire } = createHarness()
    let finishRead!: (value: null) => void
    const pendingRead = new Promise<null>((resolve) => {
      finishRead = resolve
    })
    const readBundle = vi.fn().mockResolvedValueOnce(null).mockReturnValueOnce(pendingRead)
    let supervisor!: MobileEndpointSupervisor
    let starting!: Promise<void>
    mocks.open.mockImplementation((_host, onLog: ConnectionLogSink): RpcClient => {
      const client = new FakeLogicalClient('disconnected', 'lan')
      supervisor = new MobileEndpointSupervisor(client, host, dependencies({ readBundle, onLog }))
      client.close.mockImplementation(() => supervisor.stop())
      starting = supervisor.start()
      return client
    })
    await openHostClientEntry(state, host.id)
    await vi.waitFor(() => expect(readBundle).toHaveBeenCalledTimes(2))
    expect(logs.get(host.id).length).toBeGreaterThan(0)
    await retire()
    expect(logs.get(host.id)).toEqual([])
    finishRead(null)
    await starting
    expect(logs.get(host.id)).toEqual([])
  })
})
