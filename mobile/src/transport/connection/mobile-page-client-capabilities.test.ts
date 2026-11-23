import { describe, expect, it } from 'vitest'
import { notePageVersion, watchPageClientCapabilities } from './mobile-page-client-capabilities'
import {
  readvertiseOnPageChange,
  settleMobileRuntimeCapabilities
} from './mobile-runtime-capability-negotiation'
import type { ConnectionState } from './connection-state'
import type { RpcClient } from '../rpc/rpc-client-contract'

const ROWS = { clientCapabilities: expect.arrayContaining(['browser.clientHost.rows.v1']) }

async function advertised(hostId: string): Promise<unknown> {
  let sent: unknown
  await settleMobileRuntimeCapabilities(async (_method, params) => {
    sent = params
    return { id: '1', ok: true, result: {} }
  }, hostId)
  return sent
}

describe('page-drawn client capabilities', () => {
  it('advertises This-device rows only while the page loaded for that host draws them', async () => {
    let changes = 0
    const stop = watchPageClientCapabilities('host-a', () => changes++)
    expect(await advertised('host-a')).not.toEqual(ROWS)

    notePageVersion('host-a', 4)
    expect(await advertised('host-a')).toEqual(ROWS)
    expect(await advertised('host-b')).not.toEqual(ROWS)

    // An older cached page replaces it: the host must stop sending rows that page would stream.
    notePageVersion('host-a', 3)
    expect(await advertised('host-a')).not.toEqual(ROWS)
    expect(changes).toBe(2)
    stop()
  })

  it('sends a page change made while connecting once the socket connects', async () => {
    let state: ConnectionState = 'handshaking'
    const stateListeners = new Set<(next: ConnectionState) => void>()
    const sent: unknown[] = []
    const client: RpcClient = {
      sendRequest: async (_method, params) => {
        sent.push(params)
        return { id: '1', ok: true, result: {} }
      },
      subscribe: () => () => {},
      updateTerminalSubscriptionViewport: () => {},
      getState: () => state,
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => null,
      onStateChange: (listener) => {
        stateListeners.add(listener)
        return () => stateListeners.delete(listener)
      },
      notifyForeground: () => {},
      close: () => {}
    }
    const publish = (next: ConnectionState): void => {
      state = next
      for (const listener of stateListeners) {
        listener(next)
      }
    }
    const stop = readvertiseOnPageChange('host-c', client)

    // Authentication already read the old list; this change must not be lost.
    notePageVersion('host-c', 4)
    expect(sent).toEqual([])
    publish('connected')
    await Promise.resolve()
    expect(sent).toEqual([ROWS])

    // Already heard: a later reconnect advertises during authentication, not here.
    publish('reconnecting')
    publish('connected')
    await Promise.resolve()
    expect(sent).toHaveLength(1)
    stop()
  })
})
