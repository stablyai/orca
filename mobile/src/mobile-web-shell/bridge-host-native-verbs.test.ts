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
import { clientFrame, flushBridge } from './bridge-host-test-fakes'
import { BRIDGE_NATIVE_REFUSAL_CODE } from './bridge-host-errors'

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

describe('a native method the page asks for', () => {
  it('is answered by the shell and never forwarded to the desktop', async () => {
    const bridge = harness({ clipboardText: 'from the pasteboard' })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(request('native.clipboard.read', { mime: 'text' }))
    await flushBridge()
    expect(bridge.client.requests).toEqual([])
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
    expect(bridge.client.requests).toEqual([])
    expect(replyPayload(bridge)).toEqual({ id: ID, ok: true, result: { written: true } })
  })

  it('refuses a verb this shell has no row for, before anything is forwarded', async () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(request('native.dictation.start', {}))
    await flushBridge()
    expect(bridge.client.requests).toEqual([])
    expect(refusal(bridge)?.code).toBe(BRIDGE_NATIVE_REFUSAL_CODE)
  })

  it('refuses params the verb does not take', async () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(request('native.clipboard.write', { mime: 'text' }))
    await flushBridge()
    expect(bridge.client.requests).toEqual([])
    expect(refusal(bridge)?.code).toBe(BRIDGE_NATIVE_REFUSAL_CODE)
  })

  it('turns a handler that rejects into an error frame, still forwarding nothing', async () => {
    const bridge = harness({
      serveNativeVerb: () => Promise.reject(new Error('the pasteboard is unavailable'))
    })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(request('native.clipboard.read', { mime: 'text' }))
    await flushBridge()
    expect(bridge.client.requests).toEqual([])
    expect(refusal(bridge)?.message).toContain('the pasteboard is unavailable')
  })

  it('counts against the same in-flight cap a forwarded request does', async () => {
    const bridge = harness()
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(request('native.clipboard.read', { mime: 'text' }))
    // The id is still in flight, so a second request naming it is refused by the cap machinery
    // rather than served twice — the seam changed none of that.
    bridge.host.receive(request('native.clipboard.read', { mime: 'text' }))
    expect(bridge.last().type).toBe('error')
    await flushBridge()
    expect(bridge.client.requests).toEqual([])
  })

  it('refuses a read the page could never receive, rather than truncating it', async () => {
    const bridge = harness({ clipboardText: 'a'.repeat(9 * 1024 * 1024) })
    bridge.host.receive(clientFrame({ type: 'ready' }))
    bridge.host.receive(request('native.clipboard.read', { mime: 'text' }))
    await flushBridge()
    expect(bridge.client.requests).toEqual([])
    // The reply byte cap every forwarded reply gets, applied by the same `sendReply`.
    expect(refusal(bridge)?.message).toContain('reply-too-large')
  })
})
