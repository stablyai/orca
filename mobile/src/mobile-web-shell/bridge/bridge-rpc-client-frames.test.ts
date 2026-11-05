import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isRpcDeliveryUnknown } from '../../transport/rpc-delivery-ambiguity'
import {
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_PENDING_REQUESTS,
  BRIDGE_MAX_SUBSCRIPTIONS
} from './bridge-caps'
import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'
import { BRIDGE_ACK_INTERVAL_FRAMES } from './bridge-client-subscriptions'
import { BRIDGE_PROTOCOL_VERSION, type BridgeHostMessage } from './bridge-envelope'
import { BRIDGE_READY_RETRY_MAX_MS } from './bridge-client-init-handshake'
import { BridgeClientClosedError, BridgeClientNotReadyError } from './bridge-rpc-client'
import {
  CONNECTION,
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
  it('asks for a session immediately and declares the storage keys it can read', () => {
    const page = createPageClient()
    expect(page.frames()).toEqual([
      {
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'ready',
        storageKeys: [
          'orca:terminalSplitLayout',
          'orca:duoChatExpanded',
          'orca:composerUsageWindow',
          'orca:composerUsageDisplay'
        ],
        connectionPathFrames: true
      }
    ])
  })

  it('stops asking once init lands', () => {
    const page = createPageClient()
    page.start()
    vi.advanceTimersByTime(BRIDGE_READY_RETRY_MAX_MS * 10)
    expect(page.sent).toHaveLength(1)
  })

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

  it('posts nothing, and says so, when the shell granted no navigate', () => {
    // Without navigate, older shells reject the whole notify; return false before the caller treats its tap as navigation.
    const page = createPageClient()
    page.deliver({ ...INIT, grants: { ...INIT.grants, native: [] } })
    const before = page.sent.length
    expect(page.client.notifyNavigate('/h/host-a/tasks')).toBe(false)
    expect(page.sent).toHaveLength(before)
  })
})

describe('bridge client before a session', () => {
  it('drops a state frame that beat init rather than priming from it', () => {
    const page = createPageClient()
    page.deliver({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'state',
      connection: { ...CONNECTION, state: 'reconnecting' }
    })
    expect(() => page.client.getState()).toThrow(BridgeClientNotReadyError)
    expect(page.diagnostics).toEqual([])
  })
})

// Catch page-listener throws locally: iOS callAsyncJavaScript would otherwise reject an already-delivered frame. Retrying cannot fix the same listener failure (ruling 34 addendum).
describe('a listener of the page that throws on a frame it received', () => {
  it('is reported once, leaves the client usable, and never escapes the delivery', () => {
    const page = createPageClient()
    page.start()
    const thrown = new Error('the pane hook could not apply it')
    page.client.onRouteUpdate(() => {
      throw thrown
    })
    const moved = {
      ...INIT,
      route: { pathname: '/h/host-a/session/wt-1', params: { paneKey: 'pane-1' } }
    }
    expect(() => page.deliver(moved)).not.toThrow()
    expect(page.diagnostics).toEqual([{ kind: 'inbound-listener-threw', error: thrown }])
    // Read the next frame too, proving the listener failed rather than the channel.
    page.deliver(eventFrame('unknown-exchange-id-0', 1, 'x'))
    expect(page.diagnostics.map((entry) => entry.kind)).toEqual([
      'inbound-listener-threw',
      'refused'
    ])
  })
})

describe('bridge client after close', () => {
  it('goes inert instead of throwing into a teardown, and posts nothing more', async () => {
    const page = createPageClient()
    page.start()
    page.client.close()
    expect(page.frames().at(-1)).toEqual({ v: BRIDGE_PROTOCOL_VERSION, type: 'close' })
    const refused = page.client.sendRequest('worktree.ps')
    await expect(refused).rejects.toThrow(BridgeClientClosedError)
    expect(() => page.client.subscribe('terminal.stream', {}, vi.fn())()).not.toThrow()
    expect(() => page.client.notifyForeground()).not.toThrow()
    expect(() => {
      page.client.updateTerminalSubscriptionViewport('t', { cols: 80, rows: 24 })
    }).not.toThrow()
    page.client.close()
    page.deliver(INIT)
    expect(page.sent).toHaveLength(2)
  })

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

  it('frees the assembler slot of every id nobody is waiting on', async () => {
    const page = createPageClient()
    page.start()
    const answer = page.client.sendRequest('worktree.ps')
    const id = idOf(page, 0)
    for (let index = 0; index < BRIDGE_MAX_PENDING_REQUESTS * 2; index += 1) {
      page.deliver({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'reply',
        id: index.toString(36).padStart(22, 'z'),
        part: { i: 0, of: 2 },
        chunk: '{"a":'
      })
    }
    const payload = { id, ok: true, result: 7, _meta: { runtimeId: 'runtime-a' } }
    const serialized = JSON.stringify(payload)
    const cut = Math.floor(serialized.length / 2)
    page.deliver({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'reply',
      id,
      part: { i: 0, of: 2 },
      chunk: serialized.slice(0, cut)
    })
    page.deliver({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'reply',
      id,
      part: { i: 1, of: 2 },
      chunk: serialized.slice(cut)
    })
    await expect(answer).resolves.toEqual(payload)
  })

  it('gives back the assembler slot of every id it settles', async () => {
    const page = createPageClient()
    page.start()
    const settled: Promise<unknown>[] = []
    for (let index = 0; index < BRIDGE_MAX_PENDING_REQUESTS; index += 1) {
      const abandoned = page.client.sendRequest('worktree.ps')
      const id = idOf(page, index)
      page.deliver({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'reply',
        id,
        part: { i: 0, of: 2 },
        chunk: '{"a":'
      })
      page.deliver({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'error',
        id,
        error: { category: 'Error', message: 'gone', isRpcDeliveryUnknown: false }
      })
      settled.push(abandoned.catch(() => undefined))
    }
    const answer = page.client.sendRequest('worktree.ps')
    const id = idOf(page, BRIDGE_MAX_PENDING_REQUESTS)
    const payload = { id, ok: true, result: 'assembled', _meta: { runtimeId: 'runtime-a' } }
    const serialized = JSON.stringify(payload)
    const cut = Math.floor(serialized.length / 2)
    page.deliver({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'reply',
      id,
      part: { i: 0, of: 2 },
      chunk: serialized.slice(0, cut)
    })
    page.deliver({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'reply',
      id,
      part: { i: 1, of: 2 },
      chunk: serialized.slice(cut)
    })
    await expect(answer).resolves.toEqual(payload)
    await Promise.all(settled)
  })
})

describe('bridge client caps', () => {
  it('frees the page slot when the subscribe frame never left the page', () => {
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
    const onData = vi.fn()
    for (let index = 0; index < BRIDGE_MAX_SUBSCRIPTIONS; index += 1) {
      page.client.subscribe('terminal.stream', {}, onData)
    }
    expect(onData).toHaveBeenCalledTimes(BRIDGE_MAX_SUBSCRIPTIONS)
    expect(onData.mock.calls.at(-1)?.[0]).toEqual({ type: 'error', message: expect.any(String) })
    expect(page.diagnostics).toHaveLength(BRIDGE_MAX_SUBSCRIPTIONS)
    live = true
    const dispose = page.client.subscribe('terminal.stream', {}, vi.fn())
    dispose()
    expect(page.frames().filter((frame) => frame.type === 'cancel')).toHaveLength(1)
  })
})

describe('bridge client acks', () => {
  it('keeps a byte-heavy stream alive beyond the host window', async () => {
    const pair = createFakeBridgePortPair()
    try {
      await pair.flush()
      const seen: unknown[] = []
      pair.client.subscribe('worktree.events', {}, (payload) => seen.push(payload))
      await pair.flush()
      const payload = 'x'.repeat(BRIDGE_MAX_MESSAGE_BYTES - 1024)
      for (let index = 0; index < 16; index += 1) {
        pair.rpc.streams[0]?.emit(payload)
        await pair.flush()
      }
      expect(seen).toEqual(Array.from({ length: 16 }, () => payload))
      expect(pair.rpc.streams[0]?.unsubscribes).toBe(0)
    } finally {
      pair.client.close()
      pair.host.dispose()
    }
  })

  it('acks a frame whose listener throws, so a listener bug cannot wedge the stream', () => {
    const page = createPageClient()
    page.start()
    page.client.subscribe('terminal.stream', {}, () => {
      throw new Error('listener bug')
    })
    const id = idOf(page, 0)
    for (let seq = 1; seq <= BRIDGE_ACK_INTERVAL_FRAMES; seq += 1) {
      // Ack even if listeners throw; the frame arrived and must not wedge the shell window or reject native delivery.
      expect(() => page.deliver(eventFrame(id, seq, seq))).not.toThrow()
    }
    expect(
      page.diagnostics.filter((entry) => entry.kind === 'inbound-listener-threw')
    ).toHaveLength(BRIDGE_ACK_INTERVAL_FRAMES)
    expect(page.frames().filter((frame) => frame.type === 'ack')).toHaveLength(1)
  })

  it('ignores an event for a stream it already disposed', () => {
    const page = createPageClient()
    page.start()
    const onData = vi.fn()
    const dispose = page.client.subscribe('terminal.stream', {}, onData)
    const id = idOf(page, 0)
    dispose()
    dispose()
    page.deliver(eventFrame(id, 1, 'late'))
    expect(onData).not.toHaveBeenCalled()
    expect(page.frames().filter((frame) => frame.type === 'cancel')).toHaveLength(1)
  })

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
