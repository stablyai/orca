import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'
import { makeRequest, stubRuntime } from './terminal-multiplex-test-harness'

describe('terminal multiplex RPC', () => {
  it('keeps view-subscriber releases balanced when a same-streamId subscribe overwrites a blocked one', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    // Why: a leaked registration permanently suppresses the model query
    // responder (terminal-query-authority.md) — the count must return to 0.
    let viewSubscriberCount = 0
    let leafResolved = false
    let resolveFirstWait: (ptyId: string) => void = () => {}
    // Why: the multiplex subscribe path resolves via resolveLiveLeafForHandle
    // (#7718); null makes subscribe A block in waitForLeafPtyId until B resolves.
    const resolveLeaf = (): { ptyId: string | null } =>
      leafResolved ? { ptyId: 'pty-1' } : { ptyId: null }
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn(resolveLeaf),
      resolveLiveLeafForHandle: vi.fn(resolveLeaf),
      waitForLeafPtyId: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveFirstWait = resolve
          })
      ),
      registerRemoteTerminalViewSubscriber: vi.fn(() => {
        viewSubscriberCount += 1
        let released = false
        return () => {
          if (!released) {
            released = true
            viewSubscriberCount -= 1
          }
        }
      }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue({ data: 'snap', cols: 80, rows: 24 }),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      handleMobileSubscribe: vi.fn().mockResolvedValue(undefined),
      handleMobileUnsubscribe: vi.fn(),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-overwrite',
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
    const sendSubscribe = (): void => {
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
    }

    // Subscribe A blocks in waitForLeafPtyId; subscribe B (same streamId)
    // then resolves the leaf directly and fully registers.
    sendSubscribe()
    await vi.waitFor(() => expect(runtime.waitForLeafPtyId).toHaveBeenCalled())
    leafResolved = true
    sendSubscribe()
    await vi.waitFor(() =>
      expect(messages.filter((msg) => JSON.parse(msg).result?.type === 'subscribed')).toHaveLength(
        1
      )
    )

    // A resumes and takes the slot; B's registration must be released, not
    // orphaned by the overwrite.
    resolveFirstWait('pty-1')
    await vi.waitFor(() =>
      expect(messages.filter((msg) => JSON.parse(msg).result?.type === 'subscribed')).toHaveLength(
        2
      )
    )

    handlers.get(7)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Unsubscribe,
          streamId: 7,
          seq: 2,
          payload: new Uint8Array()
        })
      )!
    )
    expect(viewSubscriberCount).toBe(0)

    cleanups.get('terminal-multiplex:conn-overwrite')?.()
    await dispatchPromise
  })

  it('keeps an evicted subscribe error from detaching the successor stream', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    let viewSubscriberCount = 0
    const mobileSubscribeWaiters: {
      resolve: () => void
      reject: (error: Error) => void
    }[] = []
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      // Why: the multiplex subscribe path resolves the leaf via
      // resolveLiveLeafForHandle (#7718), so it must return a live pty here.
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      registerRemoteTerminalViewSubscriber: vi.fn(() => {
        viewSubscriberCount += 1
        let released = false
        return () => {
          if (!released) {
            released = true
            viewSubscriberCount -= 1
          }
        }
      }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue({ data: 'snap', cols: 80, rows: 24 }),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      handleMobileSubscribe: vi.fn(
        () =>
          new Promise<boolean>((resolve, reject) => {
            mobileSubscribeWaiters.push({ resolve: () => resolve(true), reject })
          })
      ),
      handleMobileUnsubscribe: vi.fn(),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-evicted-error',
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
    const sendSubscribe = (): void => {
      handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: 1,
            payload: encodeTerminalStreamJson({
              streamId: 9,
              terminal: 'terminal-1',
              client: { id: 'phone-1', type: 'mobile' }
            })
          })
        )!
      )
    }

    // A registers, then blocks in handleMobileSubscribe. B (same streamId)
    // evicts A on arrival and completes its own registration.
    sendSubscribe()
    await vi.waitFor(() => expect(mobileSubscribeWaiters).toHaveLength(1))
    sendSubscribe()
    await vi.waitFor(() => expect(mobileSubscribeWaiters).toHaveLength(2))
    mobileSubscribeWaiters[1]!.resolve()
    await vi.waitFor(() =>
      expect(messages.filter((msg) => JSON.parse(msg).result?.type === 'subscribed')).toHaveLength(
        1
      )
    )
    expect(viewSubscriberCount).toBe(1)

    // A's pending await now rejects. The evicted stream must not detach the
    // successor that owns the slot.
    mobileSubscribeWaiters[0]!.reject(new Error('mobile_subscribe_failed'))
    await Promise.resolve()
    await Promise.resolve()
    expect(viewSubscriberCount).toBe(1)

    cleanups.get('terminal-multiplex:conn-evicted-error')?.()
    await dispatchPromise
    expect(viewSubscriberCount).toBe(0)
  })

  it('rejects a stale terminal handle with terminal_handle_stale instead of binding the wrong PTY', async () => {
    // Why: after a reconnect a client can resubscribe with a handle whose
    // pane now hosts a different PTY. Binding the stream anyway would mirror
    // (and type into) the wrong terminal (#7718); the client recovers from
    // terminal_handle_stale by re-deriving the handle from the next snapshot.
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn(() => {
        throw new Error('terminal_handle_stale')
      }),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
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
        connectionId: 'conn-stale-handle',
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
            streamId: 9,
            terminal: 'stale-terminal',
            client: { id: 'desktop-1', type: 'desktop' }
          })
        })
      )!
    )

    await vi.waitFor(() =>
      expect(
        messages
          .map((msg) => JSON.parse(msg).result)
          .some((result) => result?.type === 'end' && result.streamId === 9)
      ).toBe(true)
    )
    const errorFrame = binaryFrames
      .map((frame) => decodeTerminalStreamFrame(frame))
      .find((frame) => frame?.opcode === TerminalStreamOpcode.Error)
    expect(errorFrame && decodeTerminalStreamText(errorFrame.payload)).toBe('terminal_handle_stale')
    // The stream must never have bound to any PTY.
    expect(runtime.subscribeToTerminalData).not.toHaveBeenCalled()

    cleanups.get('terminal-multiplex:conn-stale-handle')?.()
    await dispatchPromise
  })
})
