import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserScreencastOpcode } from '../../transport/browser-screencast-protocol'
import { isRpcDeliveryUnknown } from '../../transport/rpc-delivery-ambiguity'
import {
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_PENDING_REQUESTS,
  BRIDGE_MAX_SUBSCRIPTIONS
} from './bridge-caps'
import {
  BRIDGE_ACK_INTERVAL_BYTES,
  BRIDGE_ACK_INTERVAL_FRAMES
} from './bridge-client-subscriptions'
import {
  BRIDGE_PROTOCOL_VERSION,
  readBridgeClientMessage,
  type BridgeClientMessage,
  type BridgeHostMessage
} from './bridge-envelope'
import {
  BRIDGE_READY_RETRY_MAX_MS,
  BRIDGE_READY_RETRY_MIN_MS,
  BridgeClientCapExceededError,
  BridgeClientClosedError,
  BridgeClientNotReadyError,
  createBridgeRpcClient,
  type BridgeRpcClientDiagnostic
} from './bridge-rpc-client'

const CONNECTION = {
  state: 'connected',
  reconnectAttempt: 2,
  lastConnectedAt: 1700,
  lastInboundAt: 1800,
  generation: 5
} as const

const INIT: BridgeHostMessage = {
  v: BRIDGE_PROTOCOL_VERSION,
  type: 'init',
  sessionId: 'session-a',
  buildId: 'build-a',
  connection: CONNECTION,
  grants: { rpc: { maxPendingRequests: 64, maxSubscriptions: 32 }, native: [] }
}

function createPageClient(send?: (json: string) => void) {
  const sent: string[] = []
  const diagnostics: BridgeRpcClientDiagnostic[] = []
  let handler: ((json: string) => void) | null = null
  const client = createBridgeRpcClient({
    send: (json) => {
      sent.push(json)
      send?.(json)
    },
    onMessage: (received) => {
      handler = received
      return () => {
        handler = null
      }
    },
    onDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic)
    }
  })
  return {
    client,
    sent,
    diagnostics,
    deliver(frame: unknown): void {
      handler?.(JSON.stringify(frame))
    },
    deliverRaw(json: string): void {
      handler?.(json)
    },
    frames(): BridgeClientMessage[] {
      return sent.map((json) => {
        const read = readBridgeClientMessage(json)
        if (!read.ok) {
          throw new Error(`the shell would have refused this frame: ${read.refusal}`)
        }
        return read.message
      })
    },
    start(): void {
      this.deliver(INIT)
    }
  }
}

/** Narrows what a rejection handed back, so a test reads an error rather than asserting one. */
function readError(thrown: unknown): Error {
  if (!(thrown instanceof Error)) {
    throw new Error(`expected an Error, got ${typeof thrown}`)
  }
  return thrown
}

function eventFrame(id: string, seq: number, payload: unknown): BridgeHostMessage {
  return { v: BRIDGE_PROTOCOL_VERSION, type: 'event', id, seq, payload }
}

/** The id the client minted for the nth exchange it opened, read back off its own frame. */
function idOf(page: ReturnType<typeof createPageClient>, index: number): string {
  const frame = page.frames().filter((message) => 'id' in message)[index]
  if (frame === undefined || !('id' in frame)) {
    throw new Error('the page opened no such exchange')
  }
  return frame.id
}

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

  it('stops asking once init lands', () => {
    const page = createPageClient()
    page.start()
    vi.advanceTimersByTime(BRIDGE_READY_RETRY_MAX_MS * 10)
    expect(page.sent).toHaveLength(1)
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
      grants: INIT.grants
    })
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
  it('refuses every member and ignores what the shell says next', () => {
    const page = createPageClient()
    page.start()
    page.client.close()
    expect(page.frames().at(-1)).toEqual({ v: BRIDGE_PROTOCOL_VERSION, type: 'close' })
    expect(() => page.client.getState()).toThrow(BridgeClientClosedError)
    expect(() => page.client.sendRequest('worktree.ps')).toThrow(BridgeClientClosedError)
    expect(() => page.client.subscribe('terminal.stream', {}, vi.fn())).toThrow(
      BridgeClientClosedError
    )
    expect(() => page.client.notifyForeground()).toThrow(BridgeClientClosedError)
    page.client.close()
    page.deliver(INIT)
    expect(page.sent).toHaveLength(2)
    expect(() => page.client.getState()).toThrow(BridgeClientClosedError)
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

  it('drops a reply for an id it never opened', async () => {
    const page = createPageClient()
    page.start()
    page.deliver({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'reply',
      id: 'zzzzzzzzzzzzzzzzzzzzzz',
      payload: { id: 'x', ok: true, result: 1, _meta: { runtimeId: 'runtime-a' } }
    })
    expect(page.diagnostics).toEqual([])
    await expect(Promise.resolve()).resolves.toBeUndefined()
  })
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

  it('fails a request whose frame never left the page, without the delivery mark', async () => {
    let live = true
    const page = createPageClient(() => {
      if (!live) {
        throw new Error('the port is gone')
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
    expect(BRIDGE_ACK_INTERVAL_FRAMES * 4).toBeLessThanOrEqual(256)
    expect(BRIDGE_ACK_INTERVAL_BYTES * 4).toBeLessThanOrEqual(4 * 1024 * 1024)
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

  it('retires a stream the shell ended and reports why', () => {
    const page = createPageClient()
    page.start()
    const onData = vi.fn()
    page.client.subscribe('terminal.stream', {}, onData)
    const id = idOf(page, 0)
    page.deliver({ v: BRIDGE_PROTOCOL_VERSION, type: 'end', id, reason: 'overflow' })
    page.deliver(eventFrame(id, 1, 'after the end'))
    expect(onData).not.toHaveBeenCalled()
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

  it('asks for binary only when a listener is there to read it', () => {
    const page = createPageClient()
    page.start()
    page.client.subscribe('browser.screencast', {}, vi.fn())
    page.client.subscribe('browser.screencast', {}, vi.fn(), { onBinaryFrame: vi.fn() })
    const opened = page.frames().filter((frame) => frame.type === 'subscribe')
    expect(opened[0]).not.toHaveProperty('wantsBinary')
    expect(opened[1]).toHaveProperty('wantsBinary', true)
  })

  it('decodes to the frame a native listener would have been handed', () => {
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
      image
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
