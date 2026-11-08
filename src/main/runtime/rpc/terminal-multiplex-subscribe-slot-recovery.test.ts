import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal/terminal'
import type { RuntimeTerminalWait } from '../../../shared/runtime-terminal-contracts'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal/stream/terminal-stream-protocol'
import { makeRequest, stubRuntime } from './terminal-multiplex-test-harness'

describe('terminal multiplex RPC', () => {
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

    // A registers then waits in layout; B evicts it and completes registration.
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

    // A's failed continuation must not detach successor B.
    mobileSubscribeWaiters[0]!.reject(new Error('mobile_subscribe_failed'))
    await Promise.resolve()
    await Promise.resolve()
    expect(viewSubscriberCount).toBe(1)

    cleanups.get('terminal-multiplex:conn-evicted-error')?.()
    await dispatchPromise
    expect(viewSubscriberCount).toBe(0)
  })
})
