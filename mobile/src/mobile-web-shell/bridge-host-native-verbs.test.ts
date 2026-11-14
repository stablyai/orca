// Inspect desktop requests as well as the native error: a leaked native method would also be refused by the desktop allowlist, masking a broken fence.
import { describe, expect, it } from 'vitest'
import { ID, harness } from './bridge-host-test-harness'
import { bridgeId, clientFrame, flushBridge } from './bridge-host-test-fakes'

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
})
