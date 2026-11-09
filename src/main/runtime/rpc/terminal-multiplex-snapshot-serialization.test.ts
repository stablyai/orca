import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal/terminal'
import type { RuntimeTerminalWait } from '../../../shared/runtime-terminal-contracts'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal/stream/terminal-stream-protocol'
import { makeRequest, stubRuntime } from './terminal-multiplex-test-harness'

describe('terminal multiplex RPC', () => {
  it('falls back to smaller requested snapshots when serialized data exceeds the send budget', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi
        .fn()
        .mockResolvedValueOnce({ data: 'initial', cols: 120, rows: 40 })
        .mockResolvedValueOnce({
          data: 'x'.repeat(2 * 1024 * 1024 + 1),
          cols: 120,
          rows: 40
        })
        .mockResolvedValueOnce({
          data: 'budgeted snapshot',
          cols: 120,
          rows: 40
        }),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
      getTerminalFitOverride: vi.fn().mockReturnValue(null),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
      updateDesktopViewport: vi.fn().mockResolvedValue(true)
    })
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: TERMINAL_METHODS
    })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-budgeted-request',
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
            streamId: 14,
            terminal: 'terminal-1',
            client: { id: 'desktop-1', type: 'desktop' },
            viewport: { cols: 120, rows: 40 }
          })
        })
      )!
    )
    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
    )
    const frameCountBeforeSnapshotRequest = binaryFrames.length

    handlers.get(14)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.SnapshotRequest,
          streamId: 14,
          seq: 2,
          payload: encodeTerminalStreamJson({
            requestId: 55,
            scrollbackRows: 5000
          })
        })
      )!
    )
    await vi.waitFor(() => expect(runtime.serializeTerminalBuffer).toHaveBeenCalledTimes(3))

    const requestedFrames = binaryFrames
      .slice(frameCountBeforeSnapshotRequest)
      .map((frame) => decodeTerminalStreamFrame(frame))
    const requestedStart = requestedFrames.find(
      (frame) => frame?.opcode === TerminalStreamOpcode.SnapshotStart
    )
    expect(requestedStart && decodeTerminalStreamJson(requestedStart.payload)).toMatchObject({
      requestId: 55,
      truncatedByByteBudget: true
    })
    expect(runtime.serializeTerminalBuffer).toHaveBeenNthCalledWith(2, 'pty-1', {
      scrollbackRows: 5000
    })
    expect(runtime.serializeTerminalBuffer).toHaveBeenNthCalledWith(3, 'pty-1', {
      scrollbackRows: 1000
    })
    expect(
      requestedFrames
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
    ).toBe('budgeted snapshot')

    cleanups.get('terminal-multiplex:conn-budgeted-request')?.()
    await dispatchPromise
  })

  it('retries requested snapshots after live output overflows during serialization', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
      const handlers = new Map<
        number,
        (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
      >()
      const cleanups = new Map<string, () => void>()
      const dataListenerRef: { current?: (data: string) => void } = {}
      let resolveRequestedSnapshot: (value: {
        data: string
        cols: number
        rows: number
      }) => void = () => {}
      const runtime = stubRuntime({
        resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi
          .fn()
          .mockResolvedValueOnce({ data: 'initial', cols: 120, rows: 40 })
          .mockImplementationOnce(
            () =>
              new Promise<{ data: string; cols: number; rows: number }>((resolve) => {
                resolveRequestedSnapshot = resolve
              })
          )
          .mockResolvedValueOnce({
            data: 'retry snapshot',
            cols: 120,
            rows: 40
          }),
        getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
        getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
        getLayout: vi.fn().mockReturnValue({ seq: 1 }),
        subscribeToTerminalData: vi.fn((_: string, listener: (data: string) => void) => {
          dataListenerRef.current = listener
          return vi.fn()
        }),
        subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
        subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
        subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
        getTerminalFitOverride: vi.fn().mockReturnValue(null),
        getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
        registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
          cleanups.set(id, cleanup)
        }),
        waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
        sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
        updateDesktopViewport: vi.fn().mockResolvedValue(true)
      })
      const dispatcher = new RpcDispatcher({
        runtime,
        methods: TERMINAL_METHODS
      })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.multiplex', {}),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-request-overflow',
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
              streamId: 12,
              terminal: 'terminal-1',
              client: { id: 'desktop-1', type: 'desktop' },
              viewport: { cols: 120, rows: 40 }
            })
          })
        )!
      )
      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
      )
      const frameCountBeforeSnapshotRequest = binaryFrames.length

      handlers.get(12)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.SnapshotRequest,
            streamId: 12,
            seq: 2,
            payload: encodeTerminalStreamJson({
              requestId: 44,
              scrollbackRows: 5000
            })
          })
        )!
      )
      await vi.waitFor(() => expect(runtime.serializeTerminalBuffer).toHaveBeenCalledTimes(2))
      for (let index = 0; index < 400; index += 1) {
        dataListenerRef.current?.(String(index).padStart(3, '0') + 'x'.repeat(1021))
      }
      resolveRequestedSnapshot({ data: 'requested', cols: 120, rows: 40 })
      await vi.waitFor(() => expect(runtime.serializeTerminalBuffer).toHaveBeenCalledTimes(3))
      await vi.waitFor(() =>
        expect(
          binaryFrames
            .slice(frameCountBeforeSnapshotRequest)
            .map((frame) => decodeTerminalStreamFrame(frame))
            .some((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotEnd)
        ).toBe(true)
      )

      const requestedFrames = binaryFrames
        .slice(frameCountBeforeSnapshotRequest)
        .map((frame) => decodeTerminalStreamFrame(frame))
      const requestedStart = requestedFrames.find(
        (frame) => frame?.opcode === TerminalStreamOpcode.SnapshotStart
      )
      expect(requestedStart && decodeTerminalStreamJson(requestedStart.payload)).toMatchObject({
        requestId: 44,
        truncated: false
      })
      expect(
        requestedFrames
          .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
          .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
          .join('')
      ).toBe('retry snapshot')
      expect(
        requestedFrames
          .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
          .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
          .join('')
      ).toBe('')

      dataListenerRef.current?.('live-after-overflow')
      await vi.runOnlyPendingTimersAsync()
      const outputAfterOverflow = binaryFrames
        .slice(frameCountBeforeSnapshotRequest)
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
      expect(outputAfterOverflow).toBe('live-after-overflow')

      cleanups.get('terminal-multiplex:conn-request-overflow')?.()
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })
})
