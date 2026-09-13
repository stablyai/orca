import AsyncStorage from '@react-native-async-storage/async-storage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionLogEntry } from './types'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn()
  }
}))

describe('persisted connection log store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(AsyncStorage.getItem).mockReset()
    vi.mocked(AsyncStorage.setItem).mockReset()
    vi.mocked(AsyncStorage.setItem).mockResolvedValue(undefined)
    vi.mocked(AsyncStorage.removeItem).mockReset()
    vi.mocked(AsyncStorage.removeItem).mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
  })

  it('removes persisted history and starts a new client session after re-pairing', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(null)
    const { connectionLogStore, recordConnectionClientSessionStart, forgetConnectionLogHost } =
      await import('./persisted-connection-log-store')
    recordConnectionClientSessionStart('host/a')
    await connectionLogStore.hydrate('host/a')
    recordConnectionClientSessionStart('host/a')
    expect(connectionLogStore.get('host/a')).toHaveLength(1)

    forgetConnectionLogHost('host/a')
    expect(connectionLogStore.get('host/a')).toEqual([])
    vi.setSystemTime(2_000)
    recordConnectionClientSessionStart('host/a')
    await connectionLogStore.hydrate('host/a')

    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('orca.mobile.connection-log.v1.host%2Fa')
    expect(connectionLogStore.get('host/a')).toMatchObject([
      { ts: 2_000, code: 'client-session-started' }
    ])
  })

  it('keeps a new client-session boundary when a restart shares the prior timestamp', async () => {
    const stored: ConnectionLogEntry[] = [
      {
        id: 'client-session-1000',
        ts: 1_000,
        level: 'info',
        code: 'client-session-started',
        message: 'Mobile client session started'
      },
      {
        id: 'relay-failure',
        ts: 1_000,
        level: 'error',
        code: 'relay-session-failed',
        message: 'Relay: active relay session failed'
      }
    ]
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify(stored))
    vi.resetModules()
    const { connectionLogStore, recordConnectionClientSessionStart } =
      await import('./persisted-connection-log-store')

    recordConnectionClientSessionStart('host-a')
    await connectionLogStore.hydrate('host-a')

    expect(connectionLogStore.get('host-a').map((entry) => entry.code)).toEqual([
      'client-session-started',
      'relay-session-failed',
      'client-session-started'
    ])
  })
})
