import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserScreencastOpcode } from '../../transport/browser-screencast-protocol'
import { isRpcDeliveryUnknown } from '../../transport/rpc-delivery-ambiguity'
import {
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_PENDING_REQUESTS,
  BRIDGE_MAX_SUBSCRIPTIONS
} from './bridge-caps'
import { BRIDGE_MAX_UNACKED_BYTES, BRIDGE_MAX_UNACKED_FRAMES } from '../bridge-host-subscriptions'
import {
  BRIDGE_ACK_INTERVAL_BYTES,
  BRIDGE_ACK_INTERVAL_FRAMES
} from './bridge-client-subscriptions'
import { BRIDGE_PROTOCOL_VERSION, type BridgeHostMessage } from './bridge-envelope'
import {
  BRIDGE_READY_RETRY_MAX_MS,
  BRIDGE_READY_RETRY_MIN_MS
} from './bridge-client-init-handshake'
import {
  BridgeClientCapExceededError,
  BridgeClientClosedError,
  BridgeClientNotReadyError
} from './bridge-rpc-client'
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
  it('asks for a session as soon as it exists', () => {
    const page = createPageClient()
    expect(page.frames()).toEqual([{ v: BRIDGE_PROTOCOL_VERSION, type: 'ready' }])
  })

  it('keeps asking on a widening backoff until init answers', () => {
    const page = createPageClient()
    vi.advanceTimersByTime(BRIDGE_READY_RETRY_MIN_MS)
    expect(page.sent).toHaveLength(2)
    vi.advanceTimersByTime(BRIDGE_READY_RETRY_MIN_MS)
    expect(page.sent).toHaveLength(2)
    vi.advanceTimersByTime(BRIDGE_READY_RETRY_MIN_MS)
    expect(page.sent).toHaveLength(3)
    vi.advanceTimersByTime(BRIDGE_READY_RETRY_MAX_MS * 4)
    expect(page.sent.length).toBeGreaterThan(3)
  })

  it('asks no less often than the ceiling, however long the shell stays quiet', () => {
    const page = createPageClient()
    // Past the ceiling: doubling from the floor reaches it in six steps. An unclamped backoff is
    // the same thing for a minute and then a page that gives up on a shell booting behind it.
    vi.advanceTimersByTime(BRIDGE_READY_RETRY_MAX_MS * 4)
    const asked = page.sent.length
    vi.advanceTimersByTime(BRIDGE_READY_RETRY_MAX_MS)
    expect(page.sent).toHaveLength(asked + 1)
    vi.advanceTimersByTime(BRIDGE_READY_RETRY_MAX_MS * 10)
    expect(page.sent).toHaveLength(asked + 11)
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
    // Every `ready` is answered, so a page that re-asked before the first init landed hears two.
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
    // A rebuilt host under the same page: its tables are empty, so nothing the page still holds
    // would ever be answered or ended from there.
    page.deliver({ ...INIT, sessionId: 'session-b' })
    const error = await answer.catch((thrown: unknown) => thrown)
    expect(readError(error).name).toBe('BridgeShellReplacedError')
    expect(isRpcDeliveryUnknown(error)).toBe(true)
    expect(onData.mock.calls).toEqual([[{ type: 'error', message: expect.any(String) }]])
    expect(page.client.getShellSession()?.sessionId).toBe('session-b')
  })

  it('reads the connection snapshot init primed it with', () => {
    const page = createPageClient()
    page.start()
    expect(page.client.getState()).toBe('connected')
    expect(page.client.getReconnectAttempt()).toBe(2)
    expect(page.client.getLastConnectedAt()).toBe(1700)
    expect(page.client.getLastInboundAt?.()).toBe(1800)
    expect(page.client.getGeneration?.()).toBe(5)
    expect(page.client.getShellSession()).toEqual({
      sessionId: 'session-a',
      buildId: 'build-a',
      grants: INIT.grants,
      // A shell too old to name a screen, which is a state the page has an answer for.
      route: null,
      // And one that names no page routes, so the page hands every navigation back.
      pageRoutes: [],
      pageRouteGrants: null,
      // And no host and no stored keys, which is what `host-store.web.ts` then answers with.
      host: null,
      storage: {}
    })
  })

  it('posts nothing, and says so, when the shell granted no navigate', () => {
    // An older shell: `notify` is a closed union there, so the frame would be refused whole. The
    // page has to learn that before it decides it has navigated, which is why this answers.
    const page = createPageClient()
    page.deliver({ ...INIT, grants: { ...INIT.grants, native: [] } })
    const before = page.sent.length
    expect(page.client.notifyNavigate('/h/host-a/tasks')).toBe(false)
    expect(page.sent).toHaveLength(before)
  })

  it('posts the screen it was granted the right to ask for', () => {
    const page = createPageClient()
    page.deliver({ ...INIT, grants: { ...INIT.grants, native: ['navigate'] } })
    expect(page.client.notifyNavigate('/h/host-a/tasks')).toBe(true)
    expect(JSON.parse(page.sent.at(-1) ?? '{}')).toEqual({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'notify',
      name: 'navigate',
      href: '/h/host-a/tasks'
    })
  })

  it('carries the screen the shell opened this page for', () => {
    const page = createPageClient()
    const route = { pathname: '/h/host-a/session/wt-1', params: { name: 'a branch' } }
    page.deliver({ ...INIT, route })
    expect(page.client.getShellSession()?.route).toEqual(route)
  })

  it('answers a generation the shell does not keep with a constant epoch', () => {
    const page = createPageClient()
    page.deliver({ ...INIT, connection: { ...CONNECTION, generation: null } })
    expect(page.client.getGeneration?.()).toBe(0)
  })

  it('tells a waiting listener once, and a late one immediately', () => {
    const page = createPageClient()
    const early = vi.fn()
    const dropped = vi.fn()
    const release = page.client.onReady(dropped)
    page.client.onReady(early)
    release()
    page.start()
    expect(early).toHaveBeenCalledTimes(1)
    expect(dropped).not.toHaveBeenCalled()
    const late = vi.fn()
    page.client.onReady(late)
    expect(late).toHaveBeenCalledTimes(1)
    page.deliver(INIT)
    expect(early).toHaveBeenCalledTimes(1)
  })
})

describe('bridge client before a session', () => {
  it('refuses every member that would have to answer for one', () => {
    const page = createPageClient()
    expect(() => page.client.getState()).toThrow(BridgeClientNotReadyError)
    expect(() => page.client.getReconnectAttempt()).toThrow(BridgeClientNotReadyError)
    expect(() => page.client.getLastConnectedAt()).toThrow(BridgeClientNotReadyError)
    expect(() => page.client.getLastInboundAt?.()).toThrow(BridgeClientNotReadyError)
    expect(() => page.client.getGeneration?.()).toThrow(BridgeClientNotReadyError)
    expect(() => page.client.sendRequest('worktree.ps')).toThrow(BridgeClientNotReadyError)
    expect(() => page.client.subscribe('terminal.stream', {}, vi.fn())).toThrow(
      BridgeClientNotReadyError
    )
    expect(() => page.client.notifyForeground()).toThrow(BridgeClientNotReadyError)
    expect(() =>
      page.client.updateTerminalSubscriptionViewport('t', { cols: 80, rows: 24 })
    ).toThrow(BridgeClientNotReadyError)
    expect(page.sent).toHaveLength(1)
  })

  it('still registers a state listener and still closes', () => {
    const page = createPageClient()
    const listener = vi.fn()
    expect(() => page.client.onStateChange(listener)()).not.toThrow()
    expect(() => {
      page.client.close()
    }).not.toThrow()
  })

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

  it('publishes disconnected and keeps answering the snapshot it last held', () => {
    const page = createPageClient()
    page.start()
    const listener = vi.fn()
    page.client.onStateChange(listener)
    page.client.close()
    expect(listener).toHaveBeenCalledWith('disconnected')
    expect(page.client.getState()).toBe('disconnected')
    expect(page.client.getReconnectAttempt()).toBe(CONNECTION.reconnectAttempt)
    expect(page.client.getLastConnectedAt()).toBe(CONNECTION.lastConnectedAt)
    expect(page.client.getLastInboundAt?.()).toBe(CONNECTION.lastInboundAt)
    expect(page.client.getGeneration?.()).toBe(CONNECTION.generation)
  })

  it('answers nothing it never heard: a close before init leaves the getters unready', () => {
    const page = createPageClient()
    const listener = vi.fn()
    page.client.onStateChange(listener)
    page.client.close()
    expect(listener).not.toHaveBeenCalled()
    expect(() => page.client.getState()).toThrow(BridgeClientNotReadyError)
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

  it('says goodbye once, without a cancel for each stream it owned', () => {
    const page = createPageClient()
    page.start()
    page.client.subscribe('terminal.stream', {}, vi.fn())
    page.client.subscribe('terminal.stream', {}, vi.fn())
    page.client.close()
    expect(page.frames().filter((frame) => frame.type === 'cancel')).toEqual([])
    expect(page.frames().filter((frame) => frame.type === 'close')).toHaveLength(1)
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

  it('drops a reply or an error for an id it never opened, and says so', () => {
    const page = createPageClient()
    page.start()
    const stranger = 'z'.repeat(22)
    page.deliver({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'reply',
      id: stranger,
      payload: { id: stranger, ok: true, result: 1, _meta: { runtimeId: 'runtime-a' } }
    })
    page.deliver({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'error',
      id: stranger,
      error: { category: 'Error', message: 'gone', isRpcDeliveryUnknown: false }
    })
    expect(page.diagnostics).toEqual([{ kind: 'unknown-id' }, { kind: 'unknown-id' }])
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
  it('refuses the request past the shell grant without a round trip', async () => {
    const page = createPageClient()
    page.start()
    const answers: Promise<unknown>[] = []
    for (let index = 0; index < BRIDGE_MAX_PENDING_REQUESTS; index += 1) {
      answers.push(page.client.sendRequest('worktree.ps'))
    }
    const refused = page.client.sendRequest('worktree.ps')
    await expect(refused).rejects.toThrow(BridgeClientCapExceededError)
    expect(page.sent).toHaveLength(1 + BRIDGE_MAX_PENDING_REQUESTS)
    page.client.close()
    await Promise.allSettled(answers)
  })

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
    // Every one of these is a slot the shell was never told about, and nothing will ever end it.
    for (let index = 0; index < BRIDGE_MAX_SUBSCRIPTIONS; index += 1) {
      page.client.subscribe('terminal.stream', {}, onData)
    }
    expect(onData).toHaveBeenCalledTimes(BRIDGE_MAX_SUBSCRIPTIONS)
    expect(onData.mock.calls.at(-1)?.[0]).toEqual({ type: 'error', message: expect.any(String) })
    expect(page.diagnostics).toHaveLength(BRIDGE_MAX_SUBSCRIPTIONS)
    live = true
    // Short of this, the page is at its cap for the life of the document: only a reload clears it.
    const dispose = page.client.subscribe('terminal.stream', {}, vi.fn())
    dispose()
    expect(page.frames().filter((frame) => frame.type === 'cancel')).toHaveLength(1)
  })

  it('refuses the subscription past the shell grant at the call site', () => {
    const page = createPageClient()
    page.start()
    for (let index = 0; index < BRIDGE_MAX_SUBSCRIPTIONS; index += 1) {
      page.client.subscribe('terminal.stream', {}, vi.fn())
    }
    expect(() => page.client.subscribe('terminal.stream', {}, vi.fn())).toThrow(
      BridgeClientCapExceededError
    )
    expect(page.sent).toHaveLength(1 + BRIDGE_MAX_SUBSCRIPTIONS)
  })
})

describe('bridge client acks', () => {
  it('stays well inside the window the shell ends a stream at', () => {
    // The shell's own numbers, not a copy of them: a window narrowed there has to fail here.
    expect(BRIDGE_ACK_INTERVAL_FRAMES * 4).toBeLessThanOrEqual(BRIDGE_MAX_UNACKED_FRAMES)
    expect(BRIDGE_ACK_INTERVAL_BYTES * 4).toBeLessThanOrEqual(BRIDGE_MAX_UNACKED_BYTES)
  })

  it('acks the last seq it read once the frame interval is due', () => {
    const page = createPageClient()
    page.start()
    page.client.subscribe('terminal.stream', {}, vi.fn())
    const id = idOf(page, 0)
    for (let seq = 1; seq < BRIDGE_ACK_INTERVAL_FRAMES; seq += 1) {
      page.deliver(eventFrame(id, seq, seq))
    }
    expect(page.frames().filter((frame) => frame.type === 'ack')).toEqual([])
    page.deliver(eventFrame(id, BRIDGE_ACK_INTERVAL_FRAMES, 'last'))
    expect(page.frames().filter((frame) => frame.type === 'ack')).toEqual([
      { v: BRIDGE_PROTOCOL_VERSION, type: 'ack', id, seq: BRIDGE_ACK_INTERVAL_FRAMES }
    ])
  })

  it('acks early when the bytes are due before the frames are', () => {
    const page = createPageClient()
    page.start()
    page.client.subscribe('terminal.stream', {}, vi.fn())
    const id = idOf(page, 0)
    const heavy = 'z'.repeat(BRIDGE_MAX_MESSAGE_BYTES - 1024)
    page.deliver(eventFrame(id, 1, heavy))
    page.deliver(eventFrame(id, 2, heavy))
    expect(page.frames().filter((frame) => frame.type === 'ack')).toEqual([
      { v: BRIDGE_PROTOCOL_VERSION, type: 'ack', id, seq: 2 }
    ])
  })

  it('acks a frame whose listener throws, so a listener bug cannot wedge the stream', () => {
    const page = createPageClient()
    page.start()
    page.client.subscribe('terminal.stream', {}, () => {
      throw new Error('listener bug')
    })
    const id = idOf(page, 0)
    for (let seq = 1; seq <= BRIDGE_ACK_INTERVAL_FRAMES; seq += 1) {
      expect(() => page.deliver(eventFrame(id, seq, seq))).toThrow('listener bug')
    }
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

  it('posts no cancel for a stream the shell ended before the page let go', () => {
    const page = createPageClient()
    page.start()
    const dispose = page.client.subscribe('terminal.stream', {}, vi.fn())
    const id = idOf(page, 0)
    page.deliver({ v: BRIDGE_PROTOCOL_VERSION, type: 'end', id, reason: 'closed' })
    // The screen unmounts on its own schedule, which is routinely after the shell gave up.
    dispose()
    expect(page.frames().filter((frame) => frame.type === 'cancel')).toEqual([])
  })

  it('retires a stream the shell ended, tells the listener, and reports why', () => {
    const page = createPageClient()
    page.start()
    const onData = vi.fn()
    page.client.subscribe('terminal.stream', {}, onData)
    const id = idOf(page, 0)
    page.deliver({ v: BRIDGE_PROTOCOL_VERSION, type: 'end', id, reason: 'overflow' })
    page.deliver(eventFrame(id, 1, 'after the end'))
    // The terminal result is the only thing a consumer hears. `host-worktree-refresh.ts` reads it
    // to clear the flag that says the event stream is live; without it the list never refreshes
    // again, because frames that stop arriving look exactly like a stream with nothing to say.
    expect(onData.mock.calls).toEqual([[{ type: 'error', message: expect.any(String) }]])
    expect(page.diagnostics).toEqual([{ kind: 'stream-ended', reason: 'overflow' }])
    expect(page.frames().filter((frame) => frame.type === 'cancel')).toEqual([])
  })

  it('tells the listener nothing when the page itself let the stream go', () => {
    const page = createPageClient()
    page.start()
    const onData = vi.fn()
    const dispose = page.client.subscribe('terminal.stream', {}, onData)
    dispose()
    // The caller that disposed is the one that would hear it, and it has already moved on.
    expect(onData).not.toHaveBeenCalled()
    expect(page.frames().filter((frame) => frame.type === 'cancel')).toHaveLength(1)
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

  it('asks for binary only when a listener is there to read it', () => {
    const page = createPageClient()
    page.start()
    page.client.subscribe('browser.screencast', {}, vi.fn())
    page.client.subscribe('browser.screencast', {}, vi.fn(), { onBinaryFrame: vi.fn() })
    const opened = page.frames().filter((frame) => frame.type === 'subscribe')
    expect(opened[0]).not.toHaveProperty('wantsBinary')
    expect(opened[1]).toHaveProperty('wantsBinary', true)
  })

  it('decodes to the frame a native listener would have been handed, base64 kept beside it', () => {
    const page = createPageClient()
    page.start()
    const onBinaryFrame = vi.fn()
    page.client.subscribe('browser.screencast', {}, vi.fn(), { onBinaryFrame })
    page.deliver(binaryFrame(idOf(page, 0), b64))
    expect(onBinaryFrame).toHaveBeenCalledWith({
      opcode: BrowserScreencastOpcode.Frame,
      seq: 41,
      format: 'png',
      metadata: { imageWidth: 8 },
      image,
      // The page's data URI wants base64 and this is the base64 the shell sent, so the web frame
      // path reads it instead of encoding `image` back into the same string every frame.
      b64
    })
  })

  it('carries every metadata field the shell measured', () => {
    const page = createPageClient()
    page.start()
    const onBinaryFrame = vi.fn()
    page.client.subscribe('browser.screencast', {}, vi.fn(), { onBinaryFrame })
    const metadata = {
      offsetTop: 1,
      pageScaleFactor: 2,
      deviceWidth: 3,
      deviceHeight: 4,
      imageWidth: 5,
      imageHeight: 6,
      scrollOffsetX: 7,
      scrollOffsetY: 8,
      timestamp: 9
    }
    page.deliver({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'event',
      id: idOf(page, 0),
      seq: 1,
      binary: { b64, format: 'jpeg', frameSeq: 0, metadata }
    })
    expect(onBinaryFrame).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'jpeg', seq: 0, metadata })
    )
  })

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
