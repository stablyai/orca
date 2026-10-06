/**
 * The fence: a `native.` request is answered here and never reaches the desktop.
 *
 * Every case reads `client.requests`, because that is the only thing that tells a fence which held
 * from one which leaked into a refusal that merely looks right. The desktop would refuse the
 * method too — it is absent from `MOBILE_RPC_METHOD_ALLOWLIST`, which answers `forbidden` — so a
 * leak would come back looking like an ordinary scope refusal.
 */
import { describe, expect, it } from 'vitest'
import { ID, harness } from './bridge-host-test-harness'
import { bridgeId, clientFrame, flushBridge } from './bridge-host-test-fakes'
import { BRIDGE_MAX_PENDING_REQUESTS } from './bridge/bridge-caps'

function request(method: string, params?: unknown): string {
  return params === undefined
    ? clientFrame({ type: 'request', id: ID, method })
    : clientFrame({ type: 'request', id: ID, method, params })
}

/** The body of a whole reply, or null when the last frame was not one. A chunked reply has no
 *  `payload`, which is why this narrows on the field rather than on `type` alone. */
function replyPayload(bridge: ReturnType<typeof harness>): Record<string, unknown> | null {
  const frame = bridge.last()
  return frame.type === 'reply' && 'payload' in frame ? frame.payload : null
}

/** The error a refused verb came back as, or null when the frame was not an error. */
function refusal(bridge: ReturnType<typeof harness>): { code?: unknown; message: string } | null {
  const frame = bridge.last()
  return frame.type === 'error' ? { code: frame.error.code, message: frame.error.message } : null
}

/**
 * The fence is about the method name, not the frame kind.
 *
 * `client.requests` staying empty is only half an oracle: a `subscribe` reaches the same client by
 * another door and leaves that list untouched, so every case below reads the streams too.
 */
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
    // Both answers settle the same exchange, so the page loses the request either way; which cause
    // it is told is the whole difference between a page bug it can see and one it cannot.
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

/**
 * A page that has not asked for a session has been told no caps, no grants and no route, so a
 * request from it is a frame from a document this host has said nothing to. The notify path has
 * refused that since C0; requests did not, for forwarded and native methods alike.
 */
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
    expect(bridge.clipboardWrites).toEqual([])
    expect(refusal(bridge)?.message).toContain('before-ready')
  })

  it('serves a session that handshook with the host this one replaced', async () => {
    // A client swap rebuilds the host under a live page. The page does not know: the session id is
    // the same, so it neither re-handshakes nor hears that the shell was replaced. Refusing it
    // would leave a working page dead until reload, which the gate is not for.
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

  it('serves the same request once the page has asked', async () => {
    const bridge = harness({ clipboardText: 'ready now' })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(request('native.clipboard.read', { mime: 'text' }))
    await flushBridge()
    expect(replyPayload(bridge)).toEqual({ id: ID, ok: true, result: { value: 'ready now' } })
  })
})

describe('a native method the page asks for', () => {
  it('is answered by the shell and never forwarded to the desktop', async () => {
    const bridge = harness({ clipboardText: 'from the pasteboard' })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(request('native.clipboard.read', { mime: 'text' }))
    await flushBridge()
    expect(reachedTheDesktop(bridge)).toEqual([])
    expect(replyPayload(bridge)).toEqual({
      id: ID,
      ok: true,
      result: { value: 'from the pasteboard' }
    })
  })

  it('carries no _meta, because no runtime produced it', async () => {
    const bridge = harness({ clipboardText: 'x' })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(request('native.clipboard.read', { mime: 'text' }))
    await flushBridge()
    const payload = replyPayload(bridge)
    expect(payload).not.toBeNull()
    expect(payload !== null && Object.hasOwn(payload, '_meta')).toBe(false)
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
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(request('native.dictation.start', {}))
    await flushBridge()
    expect(reachedTheDesktop(bridge)).toEqual([])
    expect(refusal(bridge)?.code).toMatch(/^native_verb_/)
  })

  it('refuses params the verb does not take', async () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(request('native.clipboard.write', { mime: 'text' }))
    await flushBridge()
    expect(reachedTheDesktop(bridge)).toEqual([])
    expect(refusal(bridge)?.code).toMatch(/^native_verb_/)
  })

  it('refuses a result the verb does not declare, rather than passing it to the page', async () => {
    // The table says what a verb answers; without this the claim was decoration and a handler
    // could hand the page any shape at all.
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
    expect(refusal(bridge)).not.toBeNull()
  })

  it('does not carry a handler message to the page, which could be what it just read', async () => {
    // A handler that puts pasteboard text in its message would otherwise hand that text back
    // through the error frame, which is the one path out of this seam that is not a result.
    const secret = 'sk-live-not-for-the-page'
    const bridge = harness({ serveNativeVerb: () => Promise.reject(new Error(secret)) })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(request('native.clipboard.read', { mime: 'text' }))
    await flushBridge()
    expect(JSON.stringify(bridge.posted)).not.toContain(secret)
  })

  it('takes a slot each, so the one over the cap is refused like any other request', async () => {
    // A handler that never settles, so every call stays in flight and the cap is what answers.
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
    settle.resolve?.({ value: 'too late' })
    await flushBridge()
    // The page moved on from this id; a reply posted now would answer an exchange it no longer has.
    expect(bridge.frames()).toHaveLength(afterCancel)
    expect(reachedTheDesktop(bridge)).toEqual([])
  })

  it('refuses a read the page could never receive, rather than truncating it', async () => {
    const bridge = harness({ clipboardText: 'a'.repeat(9 * 1024 * 1024) })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(request('native.clipboard.read', { mime: 'text' }))
    await flushBridge()
    expect(reachedTheDesktop(bridge)).toEqual([])
    // The reply byte cap every forwarded reply gets, applied by the same `sendReply`.
    expect(refusal(bridge)?.message).toContain('reply-too-large')
  })
})

/**
 * A session is granted what its route asked for, not what the app can do.
 *
 * Before this the host handed every page the whole capability set, so a route declaring only
 * navigation and storage could still read the clipboard. Harmless while every grant was something
 * the page could do anyway; not harmless once a verb reads something back.
 */
describe('grants scoped to the route the page was opened for', () => {
  const navigationOnly = ['navigate', 'storage'] as const

  it('grants a route only what it declared', () => {
    const bridge = harness({ routeGrants: navigationOnly })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    const init = bridge.last()
    expect(init.type === 'init' && init.grants.native).toEqual(['fault', 'navigate', 'storage'])
  })

  it('refuses a verb that route never asked for', async () => {
    const bridge = harness({ routeGrants: navigationOnly, ready: true })
    bridge.host.receive(request('native.clipboard.read', { mime: 'text' }))
    await flushBridge()
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

  it('refuses a notify that route never asked for, under the protocol name', () => {
    const bridge = harness({ routeGrants: ['storage'], ready: true })
    bridge.host.receive(
      clientFrame({ type: 'notify', name: 'externalLink', url: 'https://example.com/' })
    )
    expect(bridge.externalLinks).toEqual([])
    expect(bridge.diagnostics).toContainEqual({
      kind: 'notify-refused',
      name: 'externalLink',
      why: 'ungranted'
    })
  })
})
