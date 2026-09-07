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

  // 'negotiating' is not a dial stage and 'confirming' is a dial stage rather than a
  // connection state; the report echoes the name, so neither may survive.
  it('rehydrates well-formed phase timings and drops names outside their enum', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(
      JSON.stringify([
        {
          id: 'stage-ok',
          ts: 900,
          level: 'info',
          message: 'Relay dial stage awaiting-hello finished',
          timing: { kind: 'relay-dial-stage', name: 'awaiting-hello', ms: 6_400, complete: true }
        },
        {
          id: 'stage-corrupt',
          ts: 950,
          level: 'info',
          message: 'Relay dial stage handshaking finished',
          timing: { kind: 'relay-dial-stage', name: 'handshaking', ms: 'soon' }
        },
        {
          id: 'stage-unknown-name',
          ts: 960,
          level: 'info',
          message: 'Relay dial stage negotiating finished',
          timing: { kind: 'relay-dial-stage', name: 'negotiating', ms: 12, complete: true }
        },
        {
          id: 'state-borrowed-stage-name',
          ts: 970,
          level: 'info',
          message: 'Connection state confirming → connected',
          timing: { kind: 'connection-state', name: 'confirming', ms: 12, complete: true }
        },
        {
          id: 'state-unknown-kind',
          ts: 980,
          level: 'info',
          message: 'Something else',
          timing: { kind: 'wall-clock', name: 'connecting', ms: 12, complete: true }
        }
      ])
    )
    vi.resetModules()
    const { connectionLogStore } = await import('./persisted-connection-log-store')

    await connectionLogStore.hydrate('host-timings')

    expect(connectionLogStore.get('host-timings').map((entry) => entry.id)).toEqual(['stage-ok'])
    expect(connectionLogStore.get('host-timings')[0]!.timing).toEqual({
      kind: 'relay-dial-stage',
      name: 'awaiting-hello',
      ms: 6_400,
      complete: true
    })
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
