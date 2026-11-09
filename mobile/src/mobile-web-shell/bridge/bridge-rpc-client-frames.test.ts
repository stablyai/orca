import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isRpcDeliveryUnknown } from '../../transport/rpc/rpc-delivery-ambiguity'
import './bridge-caps'
import './bridge-port-pair-test-harness'
import './bridge-client-subscriptions'
import { BRIDGE_PROTOCOL_VERSION, type BridgeHostMessage } from './bridge-envelope'
import './bridge-client-init-handshake'
import {
  INIT,
  createPageClient,
  eventFrame,
  idOf,
  readError
} from './bridge-page-client-test-harness'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('bridge client handshake', () => {
  it('keeps what it holds when the same shell answers a second time', async () => {
    const page = createPageClient()
    page.start()
    const onData = vi.fn()
    const answer = page.client.sendRequest('worktree.ps')
    page.client.subscribe('terminal.stream', {}, onData)
    const id = idOf(page, 1)
    page.deliver(INIT)
    page.deliver(eventFrame(id, 1, 'still live'))
    expect(onData.mock.calls).toEqual([['still live']])
    page.deliver({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'reply',
      id: idOf(page, 0),
      payload: { id: 'wire-1', ok: true, result: 'ok', _meta: { runtimeId: 'runtime-a' } }
    })
    await expect(answer).resolves.toMatchObject({ ok: true })
  })

  it('settles everything the shell it lost was holding before adopting the new one', async () => {
    const page = createPageClient()
    page.start()
    const onData = vi.fn()
    const answer = page.client.sendRequest('worktree.ps')
    page.client.subscribe('terminal.stream', {}, onData)
    // A replacement session owns none of the old shell’s requests or streams; they must all settle locally.
    page.deliver({ ...INIT, sessionId: 'session-b' })
    const error = await answer.catch((thrown: unknown) => thrown)
    expect(readError(error).name).toBe('BridgeShellReplacedError')
    expect(isRpcDeliveryUnknown(error)).toBe(true)
    expect(onData.mock.calls).toEqual([[{ type: 'error', message: expect.any(String) }]])
    expect(page.client.getShellSession()?.sessionId).toBe('session-b')
  })
})

// Catch page-listener throws locally: iOS callAsyncJavaScript would otherwise reject an already-delivered frame. Retrying cannot fix the same listener failure (ruling 34 addendum).

describe('bridge client after close', () => {
  it('reads nothing more, even from a port that kept delivering', () => {
    const page = createPageClient({ keepDeliveringAfterUnsubscribe: true })
    page.start()
    page.client.subscribe('terminal.stream', {}, vi.fn())
    const id = idOf(page, 0)
    page.client.close()
    page.deliver(INIT)
    page.deliver(eventFrame(id, 1, 'late'))
    page.deliverRaw('{ not json')
    expect(page.diagnostics).toEqual([])
    expect(page.client.getState()).toBe('disconnected')
  })
})

describe('bridge client replies', () => {
  it('rejects with the class and the delivery mark the shell captured', async () => {
    const page = createPageClient()
    page.start()
    const answer = page.client.sendRequest('worktree.ps')
    page.deliver({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'error',
      id: idOf(page, 0),
      error: {
        category: 'RpcTimeoutError',
        message: 'timed out',
        isRpcDeliveryUnknown: true,
        code: 'ETIMEDOUT',
        cause: { category: 'Error', message: 'socket closed', isRpcDeliveryUnknown: false }
      }
    })
    const error = await answer.catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(Error)
    expect(readError(error).name).toBe('RpcTimeoutError')
    expect(isRpcDeliveryUnknown(error)).toBe(true)
    expect(readError(readError(error).cause).message).toBe('socket closed')
  })

  it('rejects a reply the assembler refuses', async () => {
    const page = createPageClient()
    page.start()
    const answer = page.client.sendRequest('worktree.ps')
    const id = idOf(page, 0)
    const part = {
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'reply',
      id,
      part: { i: 0, of: 2 },
      chunk: '{'
    }
    page.deliver(part)
    page.deliver(part)
    await expect(answer).rejects.toThrow('duplicate-part')
  })
})

describe('bridge client acks', () => {
  it('retires a stream the shell ended, tells the listener, and reports why', () => {
    const page = createPageClient()
    page.start()
    const onData = vi.fn()
    page.client.subscribe('terminal.stream', {}, onData)
    const id = idOf(page, 0)
    page.deliver({ v: BRIDGE_PROTOCOL_VERSION, type: 'end', id, reason: 'overflow' })
    page.deliver(eventFrame(id, 1, 'after the end'))
    // Notify terminal errors so host-worktree-refresh clears its live-stream flag; silent cessation looks like a quiet stream and stops future refresh.
    expect(onData.mock.calls).toEqual([[{ type: 'error', message: expect.any(String) }]])
    expect(page.diagnostics).toEqual([{ kind: 'stream-ended', reason: 'overflow' }])
    expect(page.frames().filter((frame) => frame.type === 'cancel')).toEqual([])
  })
})

describe('bridge client binary frames', () => {
  const image = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
  const b64 = btoa(String.fromCharCode(...image))

  function binaryFrame(id: string, b64Image: string): BridgeHostMessage {
    return {
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'event',
      id,
      seq: 1,
      binary: { b64: b64Image, format: 'png', frameSeq: 41, metadata: { imageWidth: 8 } }
    }
  }

  it('drops a frame with no listener and one it cannot decode', () => {
    const page = createPageClient()
    page.start()
    page.client.subscribe('browser.screencast', {}, vi.fn())
    page.deliver(binaryFrame(idOf(page, 0), b64))
    const onBinaryFrame = vi.fn()
    page.client.subscribe('browser.screencast', {}, vi.fn(), { onBinaryFrame })
    page.deliver(binaryFrame(idOf(page, 1), '!!not base64!!'))
    expect(onBinaryFrame).not.toHaveBeenCalled()
    expect(page.diagnostics).toEqual([
      { kind: 'binary-frame-dropped' },
      { kind: 'binary-frame-dropped' }
    ])
  })
})
