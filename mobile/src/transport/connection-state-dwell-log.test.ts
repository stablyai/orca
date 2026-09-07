import { describe, expect, it } from 'vitest'
import { DirectConnectionLog } from './direct-connection-log'
import { RpcClientConnectionState } from './rpc-client-connection-state'
import type { ConnectionLogEntry, ConnectionState } from './types'

function openStateWithLog(sink?: (entry: ConnectionLogEntry) => void) {
  const entries: ConnectionLogEntry[] = []
  const log = new DirectConnectionLog(
    'ws://192.168.1.50:6768',
    sink ?? ((entry) => entries.push(entry))
  )
  let now = 0
  const state = new RpcClientConnectionState({
    endpoint: 'ws://192.168.1.50:6768',
    getReconnectAttempt: () => 0,
    isClosed: () => false,
    onStateDwell: log.stateDwell,
    now: () => now
  })
  const publishAfter = (elapsedMs: number, next: ConnectionState): void => {
    now += elapsedMs
    state.publish(next)
  }
  return { entries, state, publishAfter }
}

describe('connection state dwell logging', () => {
  it('records the time spent in each state as a structured log entry', () => {
    const { entries, publishAfter } = openStateWithLog()

    publishAfter(300, 'connecting')
    publishAfter(4_200, 'handshaking')
    publishAfter(250, 'connected')

    expect(entries.map((entry) => entry.timing)).toEqual([
      { kind: 'connection-state', name: 'disconnected', ms: 300, complete: true },
      { kind: 'connection-state', name: 'connecting', ms: 4_200, complete: true },
      { kind: 'connection-state', name: 'handshaking', ms: 250, complete: true }
    ])
    expect(entries[1]!.message).toBe('Connection state connecting → handshaking')
    expect(entries[1]!.detail).toBe('4200ms in connecting')
  })

  it('skips transitions too short to explain a slow connect', () => {
    const { entries, publishAfter } = openStateWithLog()

    publishAfter(99, 'connecting')
    publishAfter(100, 'handshaking')

    expect(entries.map((entry) => entry.timing?.name)).toEqual(['connecting'])
  })

  it('does not log a dwell when the state does not change', () => {
    const { entries, publishAfter } = openStateWithLog()

    publishAfter(500, 'connecting')
    publishAfter(500, 'connecting')

    expect(entries).toHaveLength(1)
  })

  it('still publishes the state when the log sink throws', () => {
    const seen: ConnectionState[] = []
    const { state, publishAfter } = openStateWithLog(() => {
      throw new Error('sink exploded')
    })
    state.addListener((next) => seen.push(next))
    const connected = state.waitForConnected()

    publishAfter(500, 'connecting')
    publishAfter(500, 'connected')

    expect(seen).toEqual(['connecting', 'connected'])
    expect(state.get()).toBe('connected')
    return expect(connected).resolves.toBeUndefined()
  })
})
