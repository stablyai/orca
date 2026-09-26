import { describe, expect, it } from 'vitest'
import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'
import { readBridgeHostMessage } from './bridge-envelope'
import { createBridgeInitFrame } from './bridge-init-frame'
import { readShellSession } from './bridge-client-session'
import { ZERO_SAFE_AREA_INSETS, type BridgeSafeAreaInsets } from './bridge-safe-area-insets'

const PHONE: BridgeSafeAreaInsets = { top: 52, right: 0, bottom: 24, left: 0 }

function initFrame(safeAreaInsets?: BridgeSafeAreaInsets) {
  return createBridgeInitFrame({
    sessionId: 'session-a',
    buildId: 'build-a',
    connection: {
      state: 'connected',
      reconnectAttempt: 0,
      lastConnectedAt: null,
      lastInboundAt: null,
      generation: null
    },
    route: { pathname: '/h/host-a' },
    pageRoutes: ['/h/[hostId]'],
    granted: [],
    host: { id: 'host-a', name: 'Host A', endpoint: 'ws://host-a', lastConnected: 0 },
    storage: {},
    ...(safeAreaInsets === undefined ? {} : { safeAreaInsets })
  })
}

function readInit(json: string) {
  const read = readBridgeHostMessage(json)
  if (!read.ok || read.message.type !== 'init') {
    throw new Error(
      `not an init the page would read: ${read.ok ? read.message.type : read.refusal}`
    )
  }
  return read.message
}

describe('safeAreaInsets on init', () => {
  it('reads an init without the field as zeros, which is every shell before it', () => {
    const init = readInit(JSON.stringify(initFrame()))
    expect('safeAreaInsets' in init).toBe(false)
    expect(readShellSession(init).safeAreaInsets).toEqual(ZERO_SAFE_AREA_INSETS)
  })

  it('passes the shell insets through to the session the page holds', () => {
    const init = readInit(JSON.stringify(initFrame(PHONE)))
    expect(readShellSession(init).safeAreaInsets).toEqual(PHONE)
  })

  it('omits all-zero insets, since absent and zero are the same answer', () => {
    expect('safeAreaInsets' in initFrame(ZERO_SAFE_AREA_INSETS)).toBe(false)
  })

  it('refuses an init whose insets no device produces, rather than padding by them', () => {
    for (const bad of [{ ...PHONE, top: -1 }, { ...PHONE, bottom: 1e9 }, { top: 1 }]) {
      const frame = { ...initFrame(), safeAreaInsets: bad }
      expect(readBridgeHostMessage(JSON.stringify(frame)).ok, JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('insets that move under a live page', () => {
  it('re-sends init to a page that takes one, and the page reads it in place', async () => {
    const pair = createFakeBridgePortPair({ safeAreaInsets: PHONE })
    await pair.flush()
    const session = pair.client.getShellSession()
    expect(session?.safeAreaInsets).toEqual(PHONE)
    const seen: BridgeSafeAreaInsets[] = []
    pair.client.onSafeAreaInsetsUpdate((insets) => seen.push(insets))

    const keyboardUp = { ...PHONE, bottom: 0 }
    pair.host.publishSafeAreaInsets(keyboardUp)
    await pair.flush()
    expect(seen).toEqual([keyboardUp])
    expect(pair.client.getShellSession()?.safeAreaInsets).toEqual(keyboardUp)
    // Same session: an insets update is not a replacement.
    expect(pair.client.getShellSession()?.sessionId).toBe(session?.sessionId)
    expect(pair.client.getShellSession()?.route).toEqual(session?.route)
  })

  it('sends nothing for insets that did not move', async () => {
    const pair = createFakeBridgePortPair({ safeAreaInsets: PHONE })
    await pair.flush()
    const inits = () => pair.readToPage().filter((frame) => frame.type === 'init').length
    const before = inits()
    pair.host.publishSafeAreaInsets({ ...PHONE })
    await pair.flush()
    expect(inits()).toBe(before)
  })
})
