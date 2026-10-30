import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, expect, it, vi } from 'vitest'
import type { HostProfile } from '../transport/types'

vi.mock('react-native', () => ({ Platform: { OS: 'ios', Version: '27' } }))
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '0.0.60' } } }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn() }
}))

const context = {
  getState: () => 'disconnected' as const,
  getReconnectAttempt: () => 0,
  getLastConnectedAt: () => null,
  getActivePath: () => 'lan' as const,
  getPendingPath: () => null
}
const pairedHost: HostProfile = {
  id: 'desktop',
  name: 'Desktop',
  endpoint: 'ws://desktop.invalid:6768',
  deviceToken: 'device-secret',
  publicKeyB64: 'key',
  lastConnected: 0
}

beforeEach(() => {
  vi.resetModules()
  const storage = new Map<string, string>()
  vi.mocked(AsyncStorage.getItem).mockImplementation(async (key) => storage.get(key) ?? null)
  vi.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => {
    storage.set(key, value)
  })
})

it.each([null, pairedHost])(
  'retains a native render failure in the copied report after restart, host %s',
  async (host) => {
    const { recordNativeRenderError, NATIVE_APP_LOG_ID } = await import('./native-render-log')
    const { connectionLogStore } = await import('../transport/persisted-connection-log-store')
    const failure = new Error('Private prompt\n    at PRIVATE PROMPT\ntoken=do-not-share')
    failure.stack = `${failure.name}: ${failure.message}\n    at UnauthorizedAboutRoute (/Users/private/project/about.tsx:12:3)`
    recordNativeRenderError(failure, 'about')
    await connectionLogStore.hydrate(NATIVE_APP_LOG_ID)
    await connectionLogStore.flush()
    vi.resetModules()

    const { createNativeDiagnosticsOperations } = await import('./native-diagnostics-operations')
    const { report, incidentId } = await createNativeDiagnosticsOperations(host, context).report()
    expect(report).toContain('Native screen failed to render')
    expect(report).toContain('UnauthorizedAboutRoute')
    expect(report).not.toContain('Private prompt')
    expect(report).not.toContain('PRIVATE PROMPT')
    expect(report).not.toContain('do-not-share')
    expect(report).not.toContain('/Users/private')
    expect(incidentId).toBeNull()
  }
)

it('keeps a log entry when the thrown error has an unreadable stack', async () => {
  const { recordNativeRenderError, NATIVE_APP_LOG_ID } = await import('./native-render-log')
  const failure = new Error('bad stack')
  Object.defineProperty(failure, 'stack', {
    get() {
      throw new Error('unreadable')
    }
  })
  recordNativeRenderError(failure, 'pair-scan')
  const { connectionLogStore } = await import('../transport/persisted-connection-log-store')
  expect(connectionLogStore.get(NATIVE_APP_LOG_ID)).toEqual([
    expect.objectContaining({ level: 'error', detail: '/pair-scan: Error\n' })
  ])
})
