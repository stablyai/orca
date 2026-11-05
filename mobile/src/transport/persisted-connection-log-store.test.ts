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
    vi.restoreAllMocks()
    vi.clearAllTimers()
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
    const key = 'orca.mobile.connection-log.v1.host-a'
    const storage = new Map([[key, JSON.stringify(stored)]])
    vi.mocked(AsyncStorage.getItem).mockImplementation(
      async (requestedKey) => storage.get(requestedKey) ?? null
    )
    vi.mocked(AsyncStorage.setItem).mockImplementation(async (requestedKey, value) => {
      storage.set(requestedKey, value)
    })
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.25).mockReturnValue(0.5)
    vi.resetModules()
    const { connectionLogStore, recordConnectionClientSessionStart } =
      await import('./persisted-connection-log-store')

    recordConnectionClientSessionStart('host-a')
    await connectionLogStore.hydrate('host-a')

    const expected = connectionLogStore.get('host-a')
    expect(expected.map((entry) => entry.code)).toEqual([
      'client-session-started',
      'relay-session-failed',
      'client-session-started'
    ])
    await vi.advanceTimersByTimeAsync(0)
    expect(storage.get(key)).toBe(JSON.stringify(expected))
    vi.resetModules()
    const reloaded = await import('./persisted-connection-log-store')
    await reloaded.connectionLogStore.hydrate('host-a')
    expect(reloaded.connectionLogStore.get('host-a')).toEqual(expected)
  })
})
