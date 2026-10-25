// Inspect desktop requests as well as the native error: a leaked native method would also be refused by the desktop allowlist, masking a broken fence.
import { describe, expect, it } from 'vitest'
import { ID, harness } from './bridge-host-test-harness'
import { bridgeId, clientFrame, flushBridge } from './bridge-host-test-fakes'
import { BRIDGE_MAX_PENDING_REQUESTS } from './bridge/bridge-caps'

function request(method: string, params?: unknown): string {
  return params === undefined
    ? clientFrame({ type: 'request', id: ID, method })
    : clientFrame({ type: 'request', id: ID, method, params })
}

// Chunked replies have no payload; narrow on the field as well as the reply type.
function replyPayload(bridge: ReturnType<typeof harness>): Record<string, unknown> | null {
  const frame = bridge.last()
  return frame.type === 'reply' && 'payload' in frame ? frame.payload : null
}

function refusal(bridge: ReturnType<typeof harness>): { code?: unknown; message: string } | null {
  const frame = bridge.last()
  return frame.type === 'error' ? { code: frame.error.code, message: frame.error.message } : null
}

// Inspect streams too: subscribe reaches the client through a separate path without recording a request.
function reachedTheDesktop(bridge: ReturnType<typeof harness>): unknown[] {
  return [...bridge.client.requests, ...bridge.client.streams]
}

describe('a native method on a frame that is not a request', () => {
  it('opens no stream on the desktop client', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(
      clientFrame({ type: 'subscribe', id: ID, method: 'native.clipboard.read', params: {} })
    )
    expect(reachedTheDesktop(bridge)).toEqual([])
    expect(refusal(bridge)?.code).toMatch(/^native_verb_/)
  })

  it('names the collision, not the fence, when the id is one already in flight', async () => {
    // Either refusal settles the id, so choose the accurate cause without disturbing its existing exchange.
    const bridge = harness({ serveNativeVerb: () => new Promise(() => {}) })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(request('native.clipboard.read', { mime: 'text' }))
    bridge.host.receive(
      clientFrame({ type: 'subscribe', id: ID, method: 'native.clipboard.read', params: {} })
    )
    await flushBridge()
    expect(refusal(bridge)?.message).toContain('already in flight')
    expect(reachedTheDesktop(bridge)).toEqual([])
  })

  it('refuses an unknown native method on subscribe too, rather than streaming it', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(
      clientFrame({ type: 'subscribe', id: ID, method: 'native.dictation.listen', params: {} })
    )
    expect(reachedTheDesktop(bridge)).toEqual([])
    expect(refusal(bridge)?.code).toMatch(/^native_verb_/)
  })
})

// Before ready, the page has received no session, grants or caps; refuse forwarded/native requests as well as notifications.
describe('a request before the page has asked for a session', () => {
  it('is refused rather than forwarded to the desktop', async () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    await flushBridge()
    expect(reachedTheDesktop(bridge)).toEqual([])
    expect(refusal(bridge)?.message).toContain('before-ready')
  })

  it('is refused for a native verb too, before the table is even read', async () => {
    const bridge = harness()
    bridge.host.receive(request('native.clipboard.read', { mime: 'text' }))
    await flushBridge()
    expect(reachedTheDesktop(bridge)).toEqual([])
    expect(bridge.nativeCalls).toEqual([])
    expect(refusal(bridge)?.message).toContain('before-ready')
  })

  it('serves a session that handshook with the host this one replaced', async () => {
    // Client replacement preserves the live page’s established session; requiring another handshake would deadlock it until reload.
    const bridge = harness({ sessionEstablished: true, clipboardText: 'still mine' })
    bridge.host.receive(request('native.clipboard.read', { mime: 'text' }))
    await flushBridge()
    expect(replyPayload(bridge)).toEqual({ id: ID, ok: true, result: { value: 'still mine' } })
  })

  it('serves a stream for such a session too, since the rule is the session and not the frame', () => {
    const bridge = harness({ sessionEstablished: true })
    bridge.host.receive(clientFrame({ type: 'subscribe', id: ID, method: 'x.sub', params: {} }))
    expect(bridge.client.streams).toHaveLength(1)
  })

  it('refuses a stream on a session that never handshook', () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'subscribe', id: ID, method: 'x.sub', params: {} }))
    expect(bridge.client.streams).toEqual([])
    expect(refusal(bridge)?.message).toContain('before-ready')
  })
})

describe('a native method the page asks for', () => {
  it('is answered by the shell and never forwarded to the desktop', async () => {
    const bridge = harness({ clipboardText: 'from the pasteboard' })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(request('native.clipboard.read', { mime: 'text' }))
    await flushBridge()
    expect(bridge.nativeCalls).toEqual([
      { verb: 'native.clipboard.read', params: { mime: 'text' } }
    ])
    expect(reachedTheDesktop(bridge)).toEqual([])
    expect(replyPayload(bridge)).toEqual({
      id: ID,
      ok: true,
      result: { value: 'from the pasteboard' }
    })

    bridge.host.receive(
      clientFrame({
        type: 'request',
        id: bridgeId(3),
        method: 'nativeish.clipboard.read',
        params: { mime: 'text' }
      })
    )
    expect(bridge.client.requests.map(({ args }) => args)).toEqual([
      ['nativeish.clipboard.read', { mime: 'text' }]
    ])
  })

  it('writes the text it was handed and answers whether it landed', async () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(request('native.clipboard.write', { mime: 'text', value: 'copied' }))
    await flushBridge()
    expect(bridge.clipboardWrites).toEqual(['copied'])
    expect(reachedTheDesktop(bridge)).toEqual([])
    expect(replyPayload(bridge)).toEqual({ id: ID, ok: true, result: { written: true } })
  })

  it('refuses a verb this shell has no row for, before anything is forwarded', async () => {
    const bridge = harness({ ready: true })
    for (const method of ['native.dictation.start', 'native.']) {
      bridge.host.receive(request(method, {}))
      await flushBridge()
      expect(refusal(bridge)?.code, method).toBe('native_verb_unknown')
    }
    expect(bridge.nativeCalls).toEqual([])
    expect(reachedTheDesktop(bridge)).toEqual([])
  })

  it('refuses malformed clipboard params before any handler or desktop call', async () => {
    const bridge = harness({ ready: true })
    for (const params of [
      {},
      { mime: 'text' },
      { mime: 'audio', value: 'x' },
      null,
      { mime: 'text', value: 'x', unexpected: true }
    ]) {
      bridge.host.receive(request('native.clipboard.write', params))
      await flushBridge()
      expect(refusal(bridge)?.code, JSON.stringify(params)).toBe('native_verb_params')
    }
    bridge.host.receive(request('native.clipboard.read', { mime: 'image' }))
    await flushBridge()
    expect(refusal(bridge)?.code).toBe('native_verb_params')
    expect(bridge.nativeCalls).toEqual([])
    expect(reachedTheDesktop(bridge)).toEqual([])
  })

  it('refuses a result the verb does not declare, rather than passing it to the page', async () => {
    // Validate results against the verb table before an arbitrary handler reply reaches the page.
    const bridge = harness({ serveNativeVerb: () => Promise.resolve({ nonsense: 1 }) })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(request('native.clipboard.read', { mime: 'text' }))
    await flushBridge()
    expect(reachedTheDesktop(bridge)).toEqual([])
    expect(refusal(bridge)?.code).toMatch(/^native_verb_/)
    expect(replyPayload(bridge)).toBeNull()
  })

  it('turns a handler that rejects into an error frame, still forwarding nothing', async () => {
    const bridge = harness({
      serveNativeVerb: () => Promise.reject(new Error('the pasteboard is unavailable'))
    })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(request('native.clipboard.read', { mime: 'text' }))
    await flushBridge()
    expect(reachedTheDesktop(bridge)).toEqual([])
    expect(bridge.nativeCalls).toEqual([
      { verb: 'native.clipboard.read', params: { mime: 'text' } }
    ])
    expect(refusal(bridge)).toEqual({
      code: 'native_verb_failed',
      message: 'native.clipboard.read could not be served on this device'
    })
  })

  it('does not carry a handler message to the page, which could be what it just read', async () => {
    // Handler errors may contain clipboard data; error messages must not bypass declared result shapes.
    const secret = 'sk-live-not-for-the-page'
    const bridge = harness({ serveNativeVerb: () => Promise.reject(new Error(secret)) })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(request('native.clipboard.read', { mime: 'text' }))
    await flushBridge()
    expect(bridge.nativeCalls).toEqual([
      { verb: 'native.clipboard.read', params: { mime: 'text' } }
    ])
    expect(refusal(bridge)).toEqual({
      code: 'native_verb_failed',
      message: 'native.clipboard.read could not be served on this device'
    })
    expect(JSON.stringify(bridge.posted)).not.toContain(secret)
  })

  it('takes a slot each, so the one over the cap is refused like any other request', async () => {
    const bridge = harness({ serveNativeVerb: () => new Promise(() => {}) })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    for (let index = 1; index <= BRIDGE_MAX_PENDING_REQUESTS; index += 1) {
      bridge.host.receive(
        clientFrame({
          type: 'request',
          id: bridgeId(index),
          method: 'native.clipboard.read',
          params: { mime: 'text' }
        })
      )
    }
    expect(bridge.frames()).toEqual([expect.objectContaining({ type: 'init' })])
    bridge.host.receive(
      clientFrame({
        type: 'request',
        id: bridgeId(BRIDGE_MAX_PENDING_REQUESTS + 1),
        method: 'native.clipboard.read',
        params: { mime: 'text' }
      })
    )
    const overCap = bridge.last()
    expect(overCap.type === 'error' && overCap.error.message).toContain(
      `over ${BRIDGE_MAX_PENDING_REQUESTS} requests`
    )
    await flushBridge()
    expect(reachedTheDesktop(bridge)).toEqual([])
  })

  it('settles a cancelled native request the way a forwarded one settles, with no late reply', async () => {
    const settle: { resolve: ((value: unknown) => void) | null } = { resolve: null }
    const bridge = harness({
      serveNativeVerb: () =>
        new Promise((resolve) => {
          settle.resolve = resolve
        })
    })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(request('native.clipboard.read', { mime: 'text' }))
    bridge.host.receive(clientFrame({ type: 'cancel', id: ID, target: 'request' }))
    const afterCancel = bridge.frames().length
    expect(settle.resolve).not.toBeNull()
    if (settle.resolve === null) {
      throw new Error('native handler never entered')
    }
    settle.resolve({ value: 'too late' })
    await flushBridge()
    expect(bridge.frames()).toHaveLength(afterCancel)
    expect(reachedTheDesktop(bridge)).toEqual([])
  })

  it('refuses a read the page could never receive, rather than truncating it', async () => {
    const bridge = harness({ clipboardText: 'a'.repeat(9 * 1024 * 1024) })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(request('native.clipboard.read', { mime: 'text' }))
    await flushBridge()
    expect(reachedTheDesktop(bridge)).toEqual([])
    expect(refusal(bridge)?.message).toContain('reply-too-large')
  })
})

// Grant only the session route’s declared capabilities; app-wide grants would let a navigation/storage page read clipboard data.
describe('grants scoped to the route the page was opened for', () => {
  const navigationOnly = ['navigate', 'storage'] as const

  it('refuses a verb that route never asked for', async () => {
    const bridge = harness({ routeGrants: navigationOnly, ready: true })
    expect(bridge.last()).toMatchObject({
      type: 'init',
      grants: { native: ['fault', 'rpcEnvelope', 'navigate', 'storage'] }
    })
    for (const [method, params] of [
      ['native.clipboard.read', { mime: 'text' }],
      ['native.media.pick', { source: 'library', multiple: false }],
      ['native.media.read', { handle: 'media-1', offset: 0, length: 16 }],
      ['native.media.release', { handle: 'media-1' }]
    ] as const) {
      bridge.host.receive(request(method, params))
      await flushBridge()
      expect(refusal(bridge)?.code, method).toBe('native_verb_ungranted')
    }
    expect(bridge.nativeCalls).toEqual([])
    expect(reachedTheDesktop(bridge)).toEqual([])
    expect(refusal(bridge)?.code).toBe('native_verb_ungranted')
  })

  it('serves it for a route that did ask', async () => {
    const bridge = harness({
      routeGrants: [...navigationOnly, 'native.clipboard.read'],
      clipboardText: 'granted',
      ready: true
    })
    bridge.host.receive(request('native.clipboard.read', { mime: 'text' }))
    await flushBridge()
    expect(replyPayload(bridge)).toEqual({ id: ID, ok: true, result: { value: 'granted' } })
  })

  it('refuses valid notifications without their route grants', () => {
    const bridge = harness({ routeGrants: [], ready: true })
    const frames = [
      { name: 'externalLink', url: 'https://example.com/' },
      { name: 'navigate', href: '/h/host-a/session/wt-1' },
      { name: 'navigate-back' },
      { name: 'storage', key: 'orca:pins:host-a', value: '["wt-1"]' }
    ]
    for (const frame of frames) {
      bridge.host.receive(clientFrame({ type: 'notify', ...frame }))
    }
    expect(bridge.externalLinks).toEqual([])
    expect(bridge.navigations).toEqual([])
    expect(bridge.backPops).toEqual([])
    expect(bridge.storageWrites).toEqual([])
    expect(bridge.diagnostics).toEqual(
      frames.map(({ name }) => ({ kind: 'notify-refused', name, why: 'ungranted' }))
    )
  })
})
