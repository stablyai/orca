import { describe, expect, it } from 'vitest'
import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'
import { readBridgeHostMessage } from './bridge-envelope'
import { createBridgeInitFrame } from './bridge-init-frame'
import { readShellSession } from './bridge-client-session'
import { BRIDGE_KEYBOARD_INSET_ACCEPT } from './bridge-keyboard-inset'
import { createPageReadyFrame } from './bridge-client-init-handshake'

function initFrame(keyboardInset?: number) {
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
    ...(keyboardInset === undefined ? {} : { keyboardInset })
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

describe('keyboardInset on init', () => {
  it('reads an init without the field as 0, which is every shell before it', () => {
    const init = readInit(JSON.stringify(initFrame()))
    expect('keyboardInset' in init).toBe(false)
    expect(readShellSession(init).keyboardInset).toBe(0)
  })

  it('passes the keyboard height through to the session the page holds', () => {
    expect(readShellSession(readInit(JSON.stringify(initFrame(312)))).keyboardInset).toBe(312)
  })

  it('omits 0, since absent and closed are the same answer', () => {
    expect('keyboardInset' in initFrame(0)).toBe(false)
  })

  it('refuses an init whose keyboard no device produces', () => {
    for (const bad of [-1, 1e9, Number.NaN, '312']) {
      const frame = { ...initFrame(), keyboardInset: bad }
      expect(readBridgeHostMessage(JSON.stringify(frame)).ok, String(bad)).toBe(false)
    }
  })

  it('is declared by this page build, so the shell overlays it rather than shortening it', () => {
    expect(createPageReadyFrame().accepts).toContain(BRIDGE_KEYBOARD_INSET_ACCEPT)
  })
})

describe('a keyboard that moves under a live page', () => {
  it('re-sends init on show, height change and hide, and the page reads each in place', async () => {
    const pair = createFakeBridgePortPair()
    await pair.flush()
    const session = pair.client.getShellSession()
    expect(session?.keyboardInset).toBe(0)
    const seen: number[] = []
    pair.client.onKeyboardInsetUpdate((height) => seen.push(height))

    // Pixel_API_37: the IME opens at 312, the suggestion strip grows it by 34, then it closes.
    for (const height of [312, 346, 0]) {
      pair.host.publishKeyboardInset(height)
      await pair.flush()
      expect(pair.client.getShellSession()?.keyboardInset).toBe(height)
    }
    expect(seen).toEqual([312, 346, 0])
    // Same session: a keyboard update is not a replacement.
    expect(pair.client.getShellSession()?.sessionId).toBe(session?.sessionId)
    expect(pair.client.getShellSession()?.route).toEqual(session?.route)
  })

  it('sends nothing for a height that did not move', async () => {
    const pair = createFakeBridgePortPair({ keyboardInset: 312 })
    await pair.flush()
    const inits = () => pair.readToPage().filter((frame) => frame.type === 'init').length
    const before = inits()
    pair.host.publishKeyboardInset(312)
    await pair.flush()
    expect(inits()).toBe(before)
    expect(pair.client.getShellSession()?.keyboardInset).toBe(312)
  })
})
