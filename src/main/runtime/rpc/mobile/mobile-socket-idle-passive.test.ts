import { describe, expect, it } from 'vitest'
import { countIdleBlockingConnections } from './mobile-socket-idle-passive'
import { IDLE_PASSIVE_CLIENT_CAPABILITY } from '../../../../shared/remote-runtime/protocol/orcad-runtime-capabilities'

describe('idle-blocking connection count', () => {
  it('lets a passive watcher socket leave the server free to idle out', () => {
    const sockets = new Map([
      [
        'watcher',
        { clientCapabilities: ['session-tabs.tab-delta.v1', IDLE_PASSIVE_CLIENT_CAPABILITY] }
      ],
      ['desktop', { clientCapabilities: ['session-tabs.tab-delta.v1'] }]
    ])
    expect(countIdleBlockingConnections(['watcher'], (id) => sockets.get(id))).toBe(0)
    expect(countIdleBlockingConnections(['watcher', 'desktop'], (id) => sockets.get(id))).toBe(1)
    // A socket still in its handshake has declared nothing yet, so it counts.
    expect(countIdleBlockingConnections(['handshaking'], (id) => sockets.get(id))).toBe(1)
  })
})
