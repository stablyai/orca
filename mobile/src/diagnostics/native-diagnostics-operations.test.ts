import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionState, HostProfile } from '../transport/types'
import { createNativeDiagnosticsOperations } from './native-diagnostics-operations'

const logStore = vi.hoisted(() => ({
  hydrate: vi.fn<() => Promise<void>>(),
  get: () => []
}))

vi.mock('react-native', () => ({ Platform: { OS: 'ios', Version: '26' } }))
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '0.0.60' } } }))
vi.mock('../transport/persisted-connection-log-store', () => ({ connectionLogStore: logStore }))

const host: HostProfile = {
  id: 'host-a',
  name: 'Desktop',
  endpoint: 'ws://desktop.invalid:6768',
  deviceToken: 'token',
  publicKeyB64: 'key',
  lastConnected: 1_000
}

function createContext() {
  let state: ConnectionState = 'connected'
  let lastConnectedAt: number | null = 1_000
  return {
    getState: () => state,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => lastConnectedAt,
    getActivePath: () => 'lan' as const,
    getPendingPath: () => null,
    setConnection(next: ConnectionState, connectedAt: number | null) {
      state = next
      lastConnectedAt = connectedAt
    }
  }
}

describe('native connection diagnostic reports', () => {
  beforeEach(() => {
    logStore.hydrate.mockReset().mockResolvedValue(undefined)
  })

  it('keeps the live version while its connection remains current', async () => {
    const device = createNativeDiagnosticsOperations(host, createContext(), '1.4.197')
    const { report } = await device.report()
    expect(report).toContain('State: connected')
    expect(report).toContain('Host Orca version: 1.4.197')
  })

  it('omits a captured version when hydration crosses a reconnect', async () => {
    let finishHydration = () => {}
    logStore.hydrate.mockReturnValue(
      new Promise<void>((resolve) => {
        finishHydration = resolve
      })
    )
    const context = createContext()
    const device = createNativeDiagnosticsOperations(host, context, '1.4.197')
    const pendingReport = device.report()
    context.setConnection('reconnecting', 1_000)
    context.setConnection('connected', 2_000)
    finishHydration()
    const { report } = await pendingReport
    expect(report).toContain('State: connected')
    expect(report).toContain('Host Orca version: unknown')
    expect(report).not.toContain('1.4.197')
  })

  it('does not promote a disconnected version when a connection opens during hydration', async () => {
    let finishHydration = () => {}
    logStore.hydrate.mockReturnValue(
      new Promise<void>((resolve) => {
        finishHydration = resolve
      })
    )
    const context = createContext()
    context.setConnection('disconnected', 1_000)
    const device = createNativeDiagnosticsOperations(host, context, '1.4.197')
    const pendingReport = device.report()
    context.setConnection('connected', 1_000)
    finishHydration()
    const { report } = await pendingReport
    expect(report).toContain('State: connected')
    expect(report).toContain('Host Orca version: unknown')
    expect(report).not.toContain('1.4.197')
  })

  it('keeps disconnected reports explicit even with a captured version', async () => {
    const context = createContext()
    context.setConnection('disconnected', 1_000)
    const device = createNativeDiagnosticsOperations(host, context, '1.4.197')
    const { report } = await device.report()
    expect(report).toContain('Host Orca version: unknown (not currently connected)')
    expect(report).not.toContain('1.4.197')
  })
})
