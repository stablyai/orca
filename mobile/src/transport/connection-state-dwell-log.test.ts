import { describe, expect, it } from 'vitest'
import { DirectConnectionLog } from './direct-connection-log'
import { RpcClientConnectionState } from './rpc-client-connection-state'
import type { ConnectionLogEntry } from './types'

function openStateWithLog() {
  const entries: ConnectionLogEntry[] = []
  const log = new DirectConnectionLog('ws://192.168.1.50:6768', (entry) => entries.push(entry))
  const state = new RpcClientConnectionState({
    endpoint: 'ws://192.168.1.50:6768',
    getReconnectAttempt: () => 0,
    isClosed: () => false,
    onStateDwell: log.stateDwell
  })
  return { entries, state }
}

describe('connection state dwell logging', () => {
  it('records the time spent in each state as a structured log entry', () => {
    const { entries, state } = openStateWithLog()

    state.publish('connecting')
    state.publish('handshaking')
    state.publish('connected')

    expect(entries.map((entry) => entry.timing)).toEqual([
      { kind: 'connection-state', name: 'disconnected', ms: expect.any(Number), complete: true },
      { kind: 'connection-state', name: 'connecting', ms: expect.any(Number), complete: true },
      { kind: 'connection-state', name: 'handshaking', ms: expect.any(Number), complete: true }
    ])
    for (const entry of entries) {
      expect(entry.timing!.ms).toBeGreaterThanOrEqual(0)
      expect(entry.detail).toBe(`${entry.timing!.ms}ms in ${entry.timing!.name}`)
    }
    expect(entries[1]!.message).toBe('Connection state connecting → handshaking')
  })

  it('does not log a dwell when the state does not change', () => {
    const { entries, state } = openStateWithLog()

    state.publish('connecting')
    state.publish('connecting')

    expect(entries).toHaveLength(1)
  })
})
