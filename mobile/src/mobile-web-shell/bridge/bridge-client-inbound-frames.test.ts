/** What the page does with a frame its own reader will not take: which exchange it settles,
 *  which stream it releases at the shell, and what it reports for a frame naming no exchange. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isRpcDeliveryUnknown } from '../../transport/rpc-delivery-ambiguity'
import { BRIDGE_MAX_MESSAGE_BYTES } from './bridge-caps'
import { BRIDGE_PROTOCOL_VERSION } from './bridge-envelope'
import { createPageClient, idOf, readError } from './bridge-page-client-test-harness'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('bridge client refusals and send failures', () => {
  it('reports a frame its own reader will not take, and changes nothing', () => {
    const page = createPageClient()
    page.start()
    page.deliverRaw('{ not json')
    page.deliverRaw(JSON.stringify({ v: 99, type: 'state' }))
    page.deliverRaw(`"${'z'.repeat(BRIDGE_MAX_MESSAGE_BYTES)}"`)
    expect(page.diagnostics).toEqual([
      { kind: 'refused', refusal: 'malformed-json' },
      { kind: 'refused', refusal: 'unrecognised-message' },
      { kind: 'refused', refusal: 'oversized' }
    ])
    expect(page.client.getState()).toBe('connected')
  })

  it('settles the request a reply it could not read was answering, on the same turn', async () => {
    const page = createPageClient()
    page.start()
    const answer = page.client.sendRequest('worktree.ps')
    // `{ ok: true }` with no `result`: refused by this reader and by `isRpcResponse` alike.
    page.deliver({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'reply',
      id: idOf(page, 0),
      payload: { id: 'frame-1', ok: true }
    })
    // No timer is advanced: a caller that has to wait for one has already rendered without it.
    const error = await answer.catch((thrown: unknown) => thrown)
    expect(readError(error).name).toBe('BridgeReplyRefusedError')
    expect(readError(error).message).toContain('unrecognised-message')
    // The shell answered, so the desktop ran the request; a definite failure would invite a retry.
    expect(isRpcDeliveryUnknown(error)).toBe(true)
    expect(page.diagnostics).toContainEqual({
      kind: 'refused',
      refusal: 'unrecognised-message'
    })
  })

  it('ends the stream an event it could not read belonged to, and cancels it at the shell', () => {
    const page = createPageClient()
    page.start()
    const ended: unknown[] = []
    page.client.subscribe('terminal.stream', { terminal: 't1' }, (result) => {
      ended.push(result)
    })
    page.deliver({ v: BRIDGE_PROTOCOL_VERSION, type: 'event', id: idOf(page, 0), seq: -1 })
    expect(page.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual([
      'refused',
      'stream-failed'
    ])
    expect(ended).toHaveLength(1)
    // The shell did not retire this stream — it is still sending on it — so nothing but the page's
    // own `cancel` releases the slot it holds there. Its overflow backstop counts unacked frames,
    // which a stream that has gone quiet never reaches.
    expect(page.frames().at(-1)).toEqual({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'cancel',
      id: idOf(page, 0),
      target: 'subscription'
    })
  })

  it('cancels nothing for a stream the shell has already retired', () => {
    const page = createPageClient()
    page.start()
    page.client.subscribe('terminal.stream', { terminal: 't1' }, () => undefined)
    const id = idOf(page, 0)
    const posted = page.frames().length
    page.deliver({ v: BRIDGE_PROTOCOL_VERSION, type: 'end', id, reason: 'closed' })
    page.deliver({ v: BRIDGE_PROTOCOL_VERSION, type: 'error', id, error: { message: 'gone' } })
    expect(page.frames()).toHaveLength(posted)
  })

  it('cannot settle a reply whose frame it never parsed, and nothing on the page can', async () => {
    const page = createPageClient()
    page.start()
    const answer = page.client.sendRequest('worktree.ps')
    let settled = false
    void answer.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    // The two refusals that come before the id does. `oversized` is decided on the raw string and
    // `malformed-json` on a parse that failed, so neither frame ever yields an id to settle: what
    // the page holds for it is released by `close` or by a shell replacement and by nothing else.
    // Neither arises from a host that is behaving: it chunks at the frame cap, refuses a body over
    // `BRIDGE_MAX_REPLY_BYTES` on its own side, and answers that with an `error` frame instead.
    page.deliverRaw(`{"v":1,"type":"reply","id":"${idOf(page, 0)}",`)
    page.deliverRaw(`"${'z'.repeat(BRIDGE_MAX_MESSAGE_BYTES)}"`)
    await Promise.resolve()
    expect(page.diagnostics).toEqual([
      { kind: 'refused', refusal: 'malformed-json' },
      { kind: 'refused', refusal: 'oversized' }
    ])
    expect(settled).toBe(false)
    page.client.close()
    const error = await answer.catch((thrown: unknown) => thrown)
    expect(readError(error).name).toBe('BridgeClientClosedError')
    expect(isRpcDeliveryUnknown(error)).toBe(true)
  })

  it('leaves a refused frame that names no open exchange to the diagnostic alone', async () => {
    const page = createPageClient()
    page.start()
    const answer = page.client.sendRequest('worktree.ps')
    page.deliver({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'reply',
      id: 'ZZZZZZZZZZZZZZZZZZZZZZ',
      payload: { id: 'frame-1', ok: true }
    })
    expect(page.diagnostics).toEqual([{ kind: 'refused', refusal: 'unrecognised-message' }])
    page.deliver({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'reply',
      id: idOf(page, 0),
      payload: { id: 'frame-1', ok: true, result: 7, _meta: { runtimeId: 'runtime-a' } }
    })
    await expect(answer).resolves.toEqual({
      id: 'frame-1',
      ok: true,
      result: 7,
      _meta: { runtimeId: 'runtime-a' }
    })
  })

  it('fails a request whose frame never left the page, without the delivery mark', async () => {
    let live = true
    const page = createPageClient({
      send: () => {
        if (!live) {
          throw new Error('the port is gone')
        }
      }
    })
    page.start()
    live = false
    const answer = page.client.sendRequest('worktree.ps')
    const error = await answer.catch((thrown: unknown) => thrown)
    expect(readError(error).name).toBe('BridgeSendFailedError')
    expect(isRpcDeliveryUnknown(error)).toBe(false)
    expect(page.diagnostics.at(-1)).toEqual({
      kind: 'send-failed',
      error: expect.any(Error)
    })
  })
})
