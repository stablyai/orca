import AsyncStorage from '@react-native-async-storage/async-storage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionLogEntry } from './types'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn()
  }
}))

describe('persisted connection log store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    vi.mocked(AsyncStorage.getItem).mockReset()
    vi.mocked(AsyncStorage.setItem).mockReset()
    vi.mocked(AsyncStorage.setItem).mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
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
