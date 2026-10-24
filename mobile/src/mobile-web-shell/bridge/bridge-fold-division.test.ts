import { describe, expect, it } from 'vitest'
import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'
import { readBridgeHostMessage } from './bridge-envelope'
import { createBridgeInitFrame } from './bridge-init-frame'
import { readShellSession } from './bridge-client-session'
import type { BridgeFoldDivision } from './bridge-fold-division'

// iPhone Duo, inner display, half folded: the fold band with UIKit's 20pt margins either side.
const BOOK: BridgeFoldDivision = { axis: 'vertical', start: 455.5, end: 495.5 }
const TABLETOP: BridgeFoldDivision = { axis: 'horizontal', start: 455.5, end: 495.5 }

function initFrame(foldDivision?: BridgeFoldDivision | null) {
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
    ...(foldDivision === undefined ? {} : { foldDivision })
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

describe('foldDivision on init', () => {
  it('omits no fold, and the page reads the absent field as none', () => {
    expect('foldDivision' in initFrame(null)).toBe(false)
    expect(readShellSession(readInit(JSON.stringify(initFrame()))).foldDivision).toBeNull()
  })

  it('passes the fold through to the session the page holds', () => {
    expect(readShellSession(readInit(JSON.stringify(initFrame(BOOK)))).foldDivision).toEqual(BOOK)
  })

  it('drops a fold the page cannot read without refusing the init around it', () => {
    for (const bad of [
      { ...BOOK, end: 400 },
      { ...BOOK, axis: 'diagonal' },
      { ...BOOK, start: -1 }
    ]) {
      const init = readInit(JSON.stringify({ ...initFrame(), foldDivision: bad }))
      expect(readShellSession(init).foldDivision, JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('a fold that moves under a live page', () => {
  it('re-sends init as the device folds, turns and opens, and the page reads each in place', async () => {
    const pair = createFakeBridgePortPair()
    await pair.flush()
    const sessionId = pair.client.getShellSession()?.sessionId
    const seen: (BridgeFoldDivision | null)[] = []
    pair.client.onFoldDivisionUpdate((division) => seen.push(division))

    for (const division of [BOOK, TABLETOP, null]) {
      pair.host.publishFoldDivision(division)
      await pair.flush()
      expect(pair.client.getShellSession()?.foldDivision).toEqual(division)
    }
    expect(seen).toEqual([BOOK, TABLETOP, null])
    expect(pair.client.getShellSession()?.sessionId).toBe(sessionId)
  })

  it('sends nothing for a fold that did not move', async () => {
    const pair = createFakeBridgePortPair({ foldDivision: BOOK })
    await pair.flush()
    const inits = () => pair.readToPage().filter((frame) => frame.type === 'init').length
    const before = inits()
    pair.host.publishFoldDivision({ ...BOOK })
    await pair.flush()
    expect(inits()).toBe(before)
  })
})
