import { describe, expect, it } from 'vitest'
import { readShellSession } from './bridge-client-session'
import { readBridgeHostMessage } from './bridge-envelope'
import { createBridgeInitFrame } from './bridge-init-frame'

function init(hostSwitcher: boolean | undefined) {
  return createBridgeInitFrame({
    sessionId: 's',
    buildId: 'b',
    connection: {
      state: 'connected',
      reconnectAttempt: 0,
      lastConnectedAt: null,
      lastInboundAt: null,
      generation: null
    },
    route: { pathname: '/h/host-1' },
    pageRoutes: [],
    granted: [],
    host: { id: 'host-1', name: 'Host', endpoint: 'ws://h', lastConnected: 0 },
    storage: {},
    ...(hostSwitcher === undefined ? {} : { hostSwitcher })
  })
}

function pageReads(frame: unknown): boolean {
  const read = readBridgeHostMessage(JSON.stringify(frame))
  if (!read.ok || read.message.type !== 'init') {
    throw new Error('init refused')
  }
  return readShellSession(read.message).hostSwitcher
}

describe("init's desktop-switcher fact", () => {
  it('crosses only when another desktop exists, keeping recorded frames unchanged otherwise', () => {
    expect(init(true).hostSwitcher).toBe(true)
    expect('hostSwitcher' in init(false)).toBe(false)
    expect('hostSwitcher' in init(undefined)).toBe(false)
  })

  it('reads as false from shells that predate it and from a value the page cannot read', () => {
    expect(pageReads(init(undefined))).toBe(false)
    expect(pageReads({ ...init(undefined), hostSwitcher: 'several' })).toBe(false)
  })
})
