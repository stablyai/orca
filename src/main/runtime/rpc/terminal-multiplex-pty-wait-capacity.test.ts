import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'
import {
  TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION,
  TERMINAL_MULTIPLEX_MAX_PENDING_PTY_WAITS_PER_CONNECTION
} from '../../../shared/terminal-multiplex-flow-control'
import {
  makeRequest,
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe,
  stubRuntime
} from './terminal-multiplex-test-harness'

describe('terminal multiplex RPC', () => {
  it('settles mobile multiplex PTY waits when the stream signal aborts before PTY spawn', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const controller = new AbortController()
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: null }),
      waitForLeafPtyId: vi.fn(
        (_handle: string, _timeoutMs?: number, signal?: AbortSignal) =>
          new Promise<string>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('request_aborted')), {
              once: true
            })
          })
      ),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      })
    })
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: TERMINAL_METHODS
    })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        signal: controller.signal,
        connectionId: 'conn-phone-multiplex',
        sendBinary: (bytes) => {
          binaryFrames.push(bytes)
        },
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )

    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    handlers.get(0)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          seq: 1,
          payload: encodeTerminalStreamJson({
            streamId: 7,
            terminal: 'terminal-1',
            client: { id: 'phone-1', type: 'mobile' }
          })
        })
      )!
    )

    await vi.waitFor(() => expect(runtime.waitForLeafPtyId).toHaveBeenCalled())
    const pendingWaitSignal = vi.mocked(runtime.waitForLeafPtyId).mock.calls[0]?.[2]
    expect(runtime.waitForLeafPtyId).toHaveBeenCalledWith(
      'terminal-1',
      10_000,
      expect.any(AbortSignal)
    )

    controller.abort()
    await vi.waitFor(() => expect(pendingWaitSignal?.aborted).toBe(true))

    expect(runtime.readTerminal).not.toHaveBeenCalled()
    expect(
      messages.map((msg) => JSON.parse(msg).result).filter((result) => result?.streamId === 7)
    ).toEqual([])
    expect(binaryFrames.map((frame) => decodeTerminalStreamFrame(frame)?.opcode)).not.toContain(
      TerminalStreamOpcode.Error
    )

    cleanups.get('terminal-multiplex:conn-phone-multiplex')?.()
    await dispatchPromise
  })

  it("waits for a desktop multiplex subscriber's PTY before retiring the terminal", async () => {
    let resolvePty: (ptyId: string) => void = () => {}
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: null }),
      requestRendererTerminalTabMount: vi.fn(),
      waitForLeafPtyId: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolvePty = resolve
          })
      )
    })
    const harness = startDesktopMultiplexSubscribe(runtime)
    await vi.waitFor(() =>
      expect(harness.messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() => expect(runtime.waitForLeafPtyId).toHaveBeenCalled())
    expect(runtime.requestRendererTerminalTabMount).toHaveBeenCalledWith('terminal-1')
    expect(
      harness.binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Error)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
    ).toEqual([])
    resolvePty('pty-1')
    await vi.waitFor(() =>
      expect(
        harness.binaryFrames.map((frame) => decodeTerminalStreamFrame(frame)?.opcode)
      ).toContain(TerminalStreamOpcode.SnapshotChunk)
    )
    expect(
      harness.binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Error)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
    ).toEqual([])
    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })

  it('cancels a pending desktop PTY wait when its multiplex slot unsubscribes', async () => {
    let resolvePty: (ptyId: string) => void = () => {}
    let waitSignal: AbortSignal | undefined
    const readTerminal = vi.fn().mockResolvedValue({ tail: [], truncated: false })
    const subscribeToTerminalData = vi.fn().mockReturnValue(vi.fn())
    const registerRemoteTerminalViewSubscriber = vi.fn().mockReturnValue(vi.fn())
    const waitForLeafPtyId = vi.fn(
      (_handle: string, _timeoutMs?: number, signal?: AbortSignal) =>
        new Promise<string>((resolve, reject) => {
          resolvePty = resolve
          waitSignal = signal
          signal?.addEventListener('abort', () => reject(new Error('request_aborted')), {
            once: true
          })
        })
    )
    const harness = startDesktopMultiplexSubscribe({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: null }),
      waitForLeafPtyId,
      readTerminal,
      subscribeToTerminalData,
      registerRemoteTerminalViewSubscriber
    })
    await vi.waitFor(() =>
      expect(harness.messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() => expect(waitForLeafPtyId).toHaveBeenCalled())

    harness.handlers.get(7)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Unsubscribe,
          streamId: 7,
          seq: 2,
          payload: new Uint8Array()
        })
      )!
    )
    resolvePty('pty-1')

    await vi.waitFor(() =>
      expect(waitSignal?.aborted || readTerminal.mock.calls.length > 0).toBe(true)
    )
    // Why: a closed pane must not become a hidden live-output consumer when its late PTY appears.
    expect(waitSignal?.aborted).toBe(true)
    expect(readTerminal).not.toHaveBeenCalled()
    expect(subscribeToTerminalData).not.toHaveBeenCalled()
    expect(registerRemoteTerminalViewSubscriber).not.toHaveBeenCalled()
    expect(harness.handlers.has(7)).toBe(false)

    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })

  it('cancels an older pending PTY wait when the same multiplex slot resubscribes', async () => {
    const waitSignals: AbortSignal[] = []
    const waitForLeafPtyId = vi.fn(
      (_handle: string, _timeoutMs?: number, signal?: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          if (signal) {
            waitSignals.push(signal)
          }
          signal?.addEventListener('abort', () => reject(new Error('request_aborted')), {
            once: true
          })
        })
    )
    const harness = startDesktopMultiplexSubscribe({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: null }),
      waitForLeafPtyId
    })
    await vi.waitFor(() =>
      expect(harness.messages.some((message) => JSON.parse(message).result?.type === 'ready')).toBe(
        true
      )
    )

    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() => expect(waitSignals).toHaveLength(1))
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() => expect(waitSignals).toHaveLength(2))

    expect(waitSignals[0]?.aborted).toBe(true)
    expect(waitSignals[1]?.aborted).toBe(false)
    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await vi.waitFor(() => expect(waitSignals[1]?.aborted).toBe(true))
    await harness.dispatchPromise
  })

  it('admits 128 active streams, rejects the 129th, and reuses released capacity', async () => {
    let dataSubscriberCount = 0
    let viewSubscriberCount = 0
    const harness = startDesktopMultiplexSubscribe({
      subscribeToTerminalData: vi.fn(() => {
        dataSubscriberCount += 1
        let released = false
        return () => {
          if (!released) {
            released = true
            dataSubscriberCount -= 1
          }
        }
      }),
      registerRemoteTerminalViewSubscriber: vi.fn(() => {
        viewSubscriberCount += 1
        let released = false
        return () => {
          if (!released) {
            released = true
            viewSubscriberCount -= 1
          }
        }
      })
    })
    await vi.waitFor(() =>
      expect(harness.messages.some((message) => JSON.parse(message).result?.type === 'ready')).toBe(
        true
      )
    )
    const sendSubscribe = (streamId: number): void => {
      harness.handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: streamId,
            payload: encodeTerminalStreamJson({
              streamId,
              terminal: 'terminal-1',
              client: { id: 'desktop-1', type: 'desktop' },
              capabilities: { ackOutput: 1 }
            })
          })
        )!
      )
    }
    expect(TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION).toBe(128)
    for (
      let streamId = 1;
      streamId <= TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION + 1;
      streamId += 1
    ) {
      sendSubscribe(streamId)
    }

    await vi.waitFor(() => {
      const results = harness.messages.map((message) => JSON.parse(message).result)
      const subscribedStreamIds = results
        .filter((result) => result?.type === 'subscribed')
        .map((result) => result.streamId)
      expect(subscribedStreamIds).toHaveLength(TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION)
      expect(subscribedStreamIds).toContain(44)
      expect(results).toContainEqual({
        type: 'error',
        streamId: TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION + 1,
        message: 'terminal_stream_limit_exceeded'
      })
      expect(results).toContainEqual({
        type: 'end',
        streamId: TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION + 1
      })
    })
    expect(dataSubscriberCount).toBe(TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION)
    expect(viewSubscriberCount).toBe(TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION)

    harness.handlers.get(1)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Unsubscribe,
          streamId: 1,
          seq: TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION + 2,
          payload: new Uint8Array()
        })
      )!
    )
    await vi.waitFor(() => {
      expect(dataSubscriberCount).toBe(TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION - 1)
      expect(viewSubscriberCount).toBe(TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION - 1)
      expect(harness.handlers.has(1)).toBe(false)
    })

    const retriedStreamId = TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION + 1
    sendSubscribe(retriedStreamId)
    await vi.waitFor(() => {
      const subscribedStreamIds = harness.messages
        .map((message) => JSON.parse(message).result)
        .filter((result) => result?.type === 'subscribed')
        .map((result) => result.streamId)
      expect(subscribedStreamIds).toContain(retriedStreamId)
      expect(
        harness.binaryFrames.some((bytes) => {
          const frame = decodeTerminalStreamFrame(bytes)
          return (
            frame?.streamId === retriedStreamId && frame.opcode === TerminalStreamOpcode.SnapshotEnd
          )
        })
      ).toBe(true)
    })
    expect(dataSubscriberCount).toBe(TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION)
    expect(viewSubscriberCount).toBe(TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION)

    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
    expect(dataSubscriberCount).toBe(0)
    expect(viewSubscriberCount).toBe(0)
  })

  it('reserves PTY wait capacity independently from active streams', async () => {
    const activeStreamCount = 44
    const waitSignals: AbortSignal[] = []
    const resolveWaits: ((ptyId: string) => void)[] = []
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn((terminal: string) =>
        terminal.startsWith('pending-') ? { ptyId: null } : { ptyId: `pty-${terminal}` }
      ),
      waitForLeafPtyId: vi.fn(
        (_handle: string, _timeoutMs?: number, signal?: AbortSignal) =>
          new Promise<string>((resolve, reject) => {
            if (signal) {
              waitSignals.push(signal)
            }
            resolveWaits.push(resolve)
            signal?.addEventListener('abort', () => reject(new Error('request_aborted')), {
              once: true
            })
          })
      )
    })
    const harness = startDesktopMultiplexSubscribe(runtime)
    await vi.waitFor(() =>
      expect(harness.messages.some((message) => JSON.parse(message).result?.type === 'ready')).toBe(
        true
      )
    )
    const sendSubscribe = (streamId: number, terminal: string): void => {
      harness.handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: streamId,
            payload: encodeTerminalStreamJson({
              streamId,
              terminal,
              client: { id: 'desktop-1', type: 'desktop' },
              capabilities: { ackOutput: 1 }
            })
          })
        )!
      )
    }

    for (let streamId = 1; streamId <= activeStreamCount; streamId += 1) {
      sendSubscribe(streamId, `active-${streamId}`)
    }
    await vi.waitFor(() =>
      expect(
        harness.messages.filter((message) => JSON.parse(message).result?.type === 'subscribed')
      ).toHaveLength(activeStreamCount)
    )

    for (
      let offset = 1;
      offset <= TERMINAL_MULTIPLEX_MAX_PENDING_PTY_WAITS_PER_CONNECTION + 1;
      offset += 1
    ) {
      sendSubscribe(activeStreamCount + offset, `pending-${offset}`)
    }
    await vi.waitFor(() =>
      expect(waitSignals).toHaveLength(TERMINAL_MULTIPLEX_MAX_PENDING_PTY_WAITS_PER_CONNECTION)
    )
    const rejectedStreamId =
      activeStreamCount + TERMINAL_MULTIPLEX_MAX_PENDING_PTY_WAITS_PER_CONNECTION + 1
    await vi.waitFor(() => {
      const results = harness.messages.map((message) => JSON.parse(message).result)
      expect(results).toContainEqual({
        type: 'error',
        streamId: rejectedStreamId,
        message: 'terminal_stream_limit_exceeded'
      })
      expect(results).toContainEqual({ type: 'end', streamId: rejectedStreamId })
    })

    for (const [index, resolve] of resolveWaits.entries()) {
      resolve(`pty-pending-${index + 1}`)
    }
    await vi.waitFor(() => {
      const results = harness.messages.map((message) => JSON.parse(message).result)
      expect(results.filter((result) => result?.type === 'subscribed')).toHaveLength(
        activeStreamCount + TERMINAL_MULTIPLEX_MAX_PENDING_PTY_WAITS_PER_CONNECTION
      )
      expect(
        results.filter(
          (result) =>
            result?.type === 'error' && result.message === 'terminal_stream_limit_exceeded'
        )
      ).toHaveLength(1)
    })

    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })

  it("still reports no_connected_pty when a desktop multiplex subscriber's PTY never appears", async () => {
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: null }),
      waitForLeafPtyId: vi.fn().mockRejectedValue(new Error('timeout'))
    })
    const harness = startDesktopMultiplexSubscribe(runtime)
    await vi.waitFor(() =>
      expect(harness.messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() =>
      expect(
        harness.binaryFrames.map((frame) => decodeTerminalStreamFrame(frame)?.opcode)
      ).toContain(TerminalStreamOpcode.Error)
    )
    const errorFrame = harness.binaryFrames
      .map((frame) => decodeTerminalStreamFrame(frame))
      .find((frame) => frame?.opcode === TerminalStreamOpcode.Error)
    expect(errorFrame && decodeTerminalStreamText(errorFrame.payload)).toBe('no_connected_pty')
    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })

  it('does not wait when a desktop multiplex subscriber already has a PTY', async () => {
    const runtime = stubRuntime({
      requestRendererTerminalTabMount: vi.fn(),
      waitForLeafPtyId: vi.fn()
    })
    const harness = startDesktopMultiplexSubscribe(runtime)
    await vi.waitFor(() =>
      expect(harness.messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() =>
      expect(harness.messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(
        true
      )
    )
    expect(runtime.waitForLeafPtyId).not.toHaveBeenCalled()
    expect(runtime.requestRendererTerminalTabMount).not.toHaveBeenCalled()
    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })

  it('preserves clientless multiplex subscriptions without a PTY wait', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    let cleanup: () => void = () => {}
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: null }),
      requestRendererTerminalTabMount: vi.fn(),
      waitForLeafPtyId: vi.fn(),
      registerSubscriptionCleanup: vi.fn((_id: string, callback: () => void) => {
        cleanup = callback
      })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-clientless-multiplex',
        sendBinary: (bytes) => {
          binaryFrames.push(bytes)
        },
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )
    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
    )
    handlers.get(0)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          seq: 1,
          payload: encodeTerminalStreamJson({ streamId: 7, terminal: 'terminal-1' })
        })
      )!
    )
    await vi.waitFor(() =>
      expect(binaryFrames.map((frame) => decodeTerminalStreamFrame(frame)?.opcode)).toContain(
        TerminalStreamOpcode.Error
      )
    )
    expect(runtime.waitForLeafPtyId).not.toHaveBeenCalled()
    expect(runtime.requestRendererTerminalTabMount).not.toHaveBeenCalled()
    const errorFrame = binaryFrames
      .map((frame) => decodeTerminalStreamFrame(frame))
      .find((frame) => frame?.opcode === TerminalStreamOpcode.Error)
    expect(errorFrame && decodeTerminalStreamText(errorFrame.payload)).toBe('no_connected_pty')
    cleanup()
    await dispatchPromise
  })

  it('preserves clientless legacy subscriptions without a PTY wait or mount', async () => {
    const messages: string[] = []
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: null }),
      waitForLeafPtyId: vi.fn(),
      requestRendererTerminalTabMount: vi.fn(),
      readTerminal: vi.fn().mockResolvedValue({ tail: ['scrollback'], truncated: false })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', { terminal: 'terminal-1' }),
      (msg) => messages.push(msg),
      { connectionId: 'conn-clientless-legacy' }
    )
    await dispatchPromise
    expect(runtime.waitForLeafPtyId).not.toHaveBeenCalled()
    expect(runtime.requestRendererTerminalTabMount).not.toHaveBeenCalled()
    expect(messages.map((msg) => JSON.parse(msg).result?.type)).toEqual(['subscribed', 'end'])
  })

  it('waits for a desktop legacy subscriber PTY before the scrollback-only fallback', async () => {
    const messages: string[] = []
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: null }),
      waitForLeafPtyId: vi.fn().mockRejectedValue(new Error('timeout')),
      requestRendererTerminalTabMount: vi.fn().mockReturnValue(true),
      readTerminal: vi.fn().mockResolvedValue({ tail: ['scrollback'], truncated: false })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', {
        terminal: 'terminal-1',
        client: { id: 'desktop-1', type: 'desktop' }
      }),
      (msg) => messages.push(msg),
      { connectionId: 'conn-desktop-legacy' }
    )
    await dispatchPromise
    // Widened gate: a desktop client must mount + await its late PTY, not skip
    // straight to the bare scrollback path the way it did under the mobile-only gate.
    expect(runtime.requestRendererTerminalTabMount).toHaveBeenCalledWith('terminal-1')
    expect(runtime.waitForLeafPtyId).toHaveBeenCalledWith('terminal-1', 10_000, undefined)
    expect(messages.map((msg) => JSON.parse(msg).result?.type)).toEqual(['subscribed', 'end'])
  })
})
