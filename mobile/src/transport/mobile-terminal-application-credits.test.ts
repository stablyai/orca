import '../../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../../src/main/runtime/rpc/dispatcher'
import { TERMINAL_METHODS } from '../../../src/main/runtime/rpc/methods/terminal'
import { stubRuntime } from '../../../src/main/runtime/rpc/terminal-multiplex-test-harness'
import { createSubscriptionRegistryDouble } from '../../../src/main/runtime/rpc/subscription-registry-test-double'
import { RpcClientStreamRegistry } from './rpc-client-stream-registry'
import { MobileRelayRpcStreams } from './mobile-relay-rpc-streams'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { BridgeHostSubscriptions } from '../mobile-web-shell/bridge-host-subscriptions'
import { BridgeClientSubscriptions } from '../mobile-web-shell/bridge/bridge-client-subscriptions'
import { readBridgeHostMessage } from '../mobile-web-shell/bridge/bridge-envelope'
import { TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES } from '../../../src/shared/terminal-multiplex-flow-control'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame
} from '../../../src/shared/terminal-stream-protocol'
import type { RpcClient } from './rpc-client'
import { isRpcResponse } from './rpc-response-shape'
import { isTerminalStreamEvent } from './mobile-terminal-stream-record'

afterEach(() => vi.useRealTimers())

describe('mobile terminal application credits', () => {
  it.each(['direct', 'relay'] as const)(
    '%s keeps a slow page inside the host window and recovers its exact cutoff',
    async (path) => {
      vi.useFakeTimers()
      const registry = createSubscriptionRegistryDouble()
      let produced = 0
      let emitOutput: ((data: string, meta: { seq: number; rawLength: number }) => void) | undefined
      const runtime = stubRuntime({
        resolveLeafForHandle: vi.fn(() => ({ ptyId: 'pty-1' })),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi.fn(async () => ({
          data: `at:${produced}`,
          cols: 45,
          rows: 20,
          seq: produced
        })),
        getTerminalSize: () => ({ cols: 45, rows: 20 }),
        getMobileDisplayMode: () => 'auto',
        getLayout: vi.fn().mockReturnValue({ seq: 1 }),
        subscribeToTerminalData: vi.fn((_pty, listener) => {
          emitOutput = listener
          return vi.fn()
        }),
        subscribeToTerminalResize: vi.fn(() => vi.fn()),
        handleMobileSubscribe: vi.fn().mockResolvedValue(true),
        handleMobileUnsubscribe: vi.fn(),
        sendTerminal: vi.fn().mockResolvedValue({ accepted: true, bytesWritten: 1 }),
        getDriver: () => ({ kind: 'mobile', clientId: 'phone' }),
        getTerminalFitOverride: () => null,
        waitForTerminal: vi.fn(() => new Promise(() => {})),
        registerSubscriptionCleanup: registry.registerSubscriptionCleanup,
        registerOwnedSubscriptionCleanup: registry.registerOwnedSubscriptionCleanup
      })
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
      const handlers = new Map<
        number,
        (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
      >()
      let nextId = 0
      let wireOutputBytes = 0
      let ackBytes = 0
      const options = {
        nextId: () => `req-${++nextId}`,
        getState: () => 'connected' as const,
        waitForConnected: () => Promise.resolve(),
        sendFrame(frame: { id: string; method: string; params?: unknown }) {
          void dispatcher.dispatchStreaming(
            { ...frame, authToken: 'token' },
            (json) => {
              const response: unknown = JSON.parse(json)
              if (!isRpcResponse(response)) {
                throw new Error('Invalid response')
              }
              streams.handleResponse(response)
            },
            {
              connectionId: 'phone-connection',
              sendBinary(bytes) {
                const frame = decodeTerminalStreamFrame(bytes)
                if (
                  frame?.opcode === TerminalStreamOpcode.Output ||
                  frame?.opcode === TerminalStreamOpcode.OutputSpan
                ) {
                  wireOutputBytes += frame.payload.byteLength
                }
                streams.handleBinary(bytes)
              },
              registerBinaryStreamHandler(id, handler) {
                handlers.set(id, handler)
                return () => {
                  if (handlers.get(id) === handler) {
                    handlers.delete(id)
                  }
                }
              }
            }
          )
          return true
        },
        sendBinary(bytes: Uint8Array) {
          const frame = decodeTerminalStreamFrame(bytes)
          if (!frame) {
            throw new Error('Invalid client frame')
          }
          if (frame.opcode === TerminalStreamOpcode.Ack) {
            ackBytes += JSON.parse(new TextDecoder().decode(frame.payload)).bytes
          }
          handlers.get(frame.streamId)?.(frame)
          return true
        }
      }
      const streams =
        path === 'direct'
          ? new RpcClientStreamRegistry(options)
          : new MobileRelayRpcStreams(options)
      const physical: RpcClient = {
        ...createFakeRpcClient(),
        subscribe: streams.subscribe.bind(streams),
        sendRequest: (method, params) =>
          dispatcher.dispatch({ id: `unary-${++nextId}`, method, params, authToken: 'token' })
      }
      const logical = createStableLogicalRpcClient(physical, path === 'direct' ? 'lan' : 'relay')
      const pending: (() => void)[] = []
      let rendered = ''
      const errors: unknown[] = []
      const host = new BridgeHostSubscriptions({
        client: logical,
        post(json) {
          const read = readBridgeHostMessage(json)
          if (!read.ok) {
            throw new Error('Uncarryable terminal event')
          }
          if (read.message.type === 'event') {
            page.deliver(read.message, Buffer.byteLength(json))
          }
        },
        onBinaryFrameDropped: () => {
          throw new Error('Dropped terminal output')
        }
      })
      const page = new BridgeClientSubscriptions({
        send(frame) {
          if (frame.type === 'subscribe') {
            host.start(frame.id, frame.method, frame.params)
          }
          if (frame.type === 'ack') {
            host.ack(frame.id, frame.seq)
          }
          if (frame.type === 'cancel') {
            host.cancel(frame.id, null)
          }
          return true
        },
        onDroppedBinaryFrame: () => {
          throw new Error('Dropped page frame')
        }
      })
      page.open(
        'a'.repeat(22),
        'terminal.subscribe',
        {
          terminal: 'terminal-1',
          client: { id: 'phone', type: 'mobile' },
          viewport: { cols: 45, rows: 20 },
          snapshotByteBudget: 600 * 1024,
          capabilities: { terminalBinaryStream: 1, ackOutput: 1 }
        },
        (event) => {
          const data = event
          if (!isTerminalStreamEvent(data)) {
            throw new Error('Invalid terminal event')
          }
          if (data.type === 'error') {
            errors.push(data)
          }
          if (data.type === 'scrollback') {
            rendered = String(data.serialized)
            return Promise.resolve()
          }
          if (data.type === 'data') {
            return new Promise<void>((resolve) =>
              pending.push(() => {
                rendered += typeof data.chunk === 'string' ? data.chunk : ''
                resolve()
              })
            )
          }
        }
      )
      try {
        await vi.waitFor(() => expect(rendered).toBe('at:0'))
        for (const load of [1, 10]) {
          const before = wireOutputBytes
          for (let i = 0; i < 64 * load; i++) {
            const chunk = 'x'.repeat(64 * 1024)
            produced += chunk.length
            emitOutput?.(chunk, { seq: produced, rawLength: chunk.length })
          }
          expect(wireOutputBytes - before).toBeLessThanOrEqual(
            TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES * 4
          )
          expect(wireOutputBytes - ackBytes).toBeLessThanOrEqual(2 * 1024 * 1024)
          const acknowledgements = ackBytes
          await vi.advanceTimersByTimeAsync(50)
          expect(ackBytes).toBe(acknowledgements)
          const input = await logical.sendRequest('terminal.send', {
            terminal: 'terminal-1',
            text: 'i',
            client: { id: 'phone', type: 'mobile' }
          })
          expect(input.ok).toBe(true)
          await vi.waitFor(() =>
            expect(runtime.sendTerminal).toHaveBeenCalledTimes(load === 1 ? 1 : 2)
          )
          await vi.waitFor(async () => {
            pending.splice(0).forEach((apply) => apply())
            await Promise.resolve()
            expect(rendered).toBe(`at:${produced}`)
          })
        }
        produced += 4
        emitOutput?.('TAIL', { seq: produced, rawLength: 4 })
        await vi.advanceTimersByTimeAsync(5)
        await vi.waitFor(async () => {
          pending.splice(0).forEach((apply) => apply())
          await Promise.resolve()
          expect(rendered).toBe(`at:${produced - 4}TAIL`)
        })
        expect(errors).toEqual([])
      } finally {
        page.cancel('a'.repeat(22))
        host.closeAll(null)
        registry.cleanupSubscriptionsForConnection('phone-connection')
        logical.close()
      }
      expect(runtime.handleMobileUnsubscribe).toHaveBeenCalledOnce()
      expect(handlers.size).toBe(0)
    }
  )
})
