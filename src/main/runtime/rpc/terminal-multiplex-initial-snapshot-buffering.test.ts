import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'

import { TERMINAL_METHODS } from './methods/terminal/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'
import type { RuntimeTerminalWait } from '../../../shared/runtime-terminal-contracts'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText
} from '../../../shared/terminal/stream/terminal-stream-protocol'
import { makeRequest, stubRuntime } from './terminal-multiplex-test-harness'

describe('terminal multiplex RPC', () => {
  it('replays only buffered multiplex output not covered by the initial snapshot seq', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
      const registry = createSubscriptionRegistryDouble()
      const dataListenerRef: {
        current?: (data: string, meta?: { seq?: number; rawLength?: number }) => void
      } = {}
      let resolveSnapshot: (value: {
        data: string
        cols: number
        rows: number
        seq: number
      }) => void = () => {}
      const runtime = stubRuntime({
        resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi.fn(
          () =>
            new Promise<{
              data: string
              cols: number
              rows: number
              seq: number
            }>((resolve) => {
              resolveSnapshot = resolve
            })
        ),
        getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
        getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
        getLayout: vi.fn().mockReturnValue({ seq: 1 }),
        subscribeToTerminalData: vi.fn((_: string, listener) => {
          dataListenerRef.current = listener
          return vi.fn()
        }),
        subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
        subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
        getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
        registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
        registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
        cleanupSubscription: vi.fn(registry.cleanupSubscription),
        waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
        sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
        updateDesktopViewport: vi.fn().mockResolvedValue(true)
      })
      const dispatcher = new RpcDispatcher({
        runtime,
        methods: TERMINAL_METHODS
      })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.subscribe', {
          terminal: 'terminal-1',
          client: { id: 'desktop-1', type: 'desktop' },
          capabilities: { terminalBinaryStream: 1 }
        }),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-buffered-output-partially-covered-by-snapshot',
          sendBinary: (bytes) => {
            binaryFrames.push(bytes)
          },
          registerBinaryStreamHandler: vi.fn(() => vi.fn())
        }
      )

      await vi.waitFor(() => expect(dataListenerRef.current).toBeDefined())
      const buffered = 'hello world'
      dataListenerRef.current?.(buffered, {
        seq: buffered.length,
        rawLength: buffered.length
      })
      resolveSnapshot({
        data: 'hello',
        cols: 120,
        rows: 40,
        seq: 'hello'.length
      })
      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
      )
      await vi.runOnlyPendingTimersAsync()

      const output = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
      expect(output).toBe(' world')

      runtime.cleanupSubscription('terminal-1:desktop-1')
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })
})
