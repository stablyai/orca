/* oxlint-disable max-lines -- Why: multiplex transport tests share a live dispatcher harness; splitting it would duplicate stream setup and weaken race coverage. */
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'

function stubRuntime(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    ...overrides
  } as OrcaRuntimeService
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('terminal multiplex RPC', () => {
  it('multiplexes terminal streams and routes desktop resize to the source PTY', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
      const handlers = new Map<
        number,
        (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
      >()
      const cleanups = new Map<string, () => void>()
      const dataListenerRef: {
        current?: (data: string, meta?: { seq?: number; rawLength?: number }) => void
      } = {}
      const runtime = stubRuntime({
        resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi.fn().mockResolvedValue({
          data: 'snapshot',
          cols: 120,
          rows: 40
        }),
        getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
        getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
        getLayout: vi.fn().mockReturnValue({ seq: 1 }),
        subscribeToTerminalData: vi.fn(
          (
            _: string,
            listener: (data: string, meta?: { seq?: number; rawLength?: number }) => void
          ) => {
            dataListenerRef.current = listener
            return vi.fn()
          }
        ),
        subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
        subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
        subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
        getTerminalFitOverride: vi.fn().mockReturnValue(null),
        getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
        registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
          cleanups.set(id, cleanup)
        }),
        cleanupSubscription: vi.fn((id: string) => {
          const cleanup = cleanups.get(id)
          cleanups.delete(id)
          cleanup?.()
        }),
        waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
        sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
        updateDesktopViewport: vi.fn().mockResolvedValue(true)
      })
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.multiplex', {}),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-1',
          sendBinary: (bytes) => binaryFrames.push(bytes),
          registerBinaryStreamHandler: (streamId, handler) => {
            handlers.set(streamId, handler)
            return () => handlers.delete(streamId)
          }
        }
      )

      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)
      )
      expect(handlers.has(0)).toBe(true)

      handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: 1,
            payload: encodeTerminalStreamJson({
              streamId: 5,
              terminal: 'terminal-1',
              client: { id: 'desktop-1', type: 'desktop' },
              viewport: { cols: 300, rows: 150 }
            })
          })
        )!
      )

      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
      )
      expect(messages.map((msg) => JSON.parse(msg).result)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'fit-override-changed',
            streamId: 5,
            mode: 'desktop-fit'
          }),
          expect.objectContaining({
            type: 'driver-changed',
            streamId: 5,
            driver: { kind: 'idle' }
          })
        ])
      )
      expect(runtime.updateDesktopViewport).toHaveBeenCalledWith('pty-1', {
        cols: 300,
        rows: 150
      })
      expect(handlers.has(5)).toBe(true)

      dataListenerRef.current?.('a')
      dataListenerRef.current?.('b')
      await vi.runOnlyPendingTimersAsync()

      const outputFrames = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
      expect(outputFrames).toHaveLength(1)
      expect(outputFrames[0]?.streamId).toBe(5)
      expect(outputFrames[0] ? decodeTerminalStreamText(outputFrames[0].payload) : '').toBe('ab')

      handlers.get(5)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Input,
            streamId: 5,
            seq: 2,
            payload: encodeTerminalStreamText('ls\r')
          })
        )!
      )
      await vi.waitFor(() =>
        expect(runtime.sendTerminal).toHaveBeenCalledWith('terminal-1', {
          text: 'ls\r',
          enter: false,
          interrupt: false
        })
      )

      handlers.get(5)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Resize,
            streamId: 5,
            seq: 3,
            payload: encodeTerminalStreamJson({ cols: 100, rows: 30 })
          })
        )!
      )
      await vi.waitFor(() =>
        expect(runtime.updateDesktopViewport).toHaveBeenLastCalledWith('pty-1', {
          cols: 100,
          rows: 30
        })
      )

      const snapshotStartFrame = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .find((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotStart)
      expect(
        snapshotStartFrame && decodeTerminalStreamJson(snapshotStartFrame.payload)
      ).toMatchObject({
        cols: 120,
        rows: 40
      })

      const frameCountBeforeSnapshotRequest = binaryFrames.length
      handlers.get(5)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.SnapshotRequest,
            streamId: 5,
            seq: 4,
            payload: encodeTerminalStreamJson({ requestId: 7, scrollbackRows: 5000 })
          })
        )!
      )
      await vi.waitFor(() =>
        expect(
          binaryFrames
            .slice(frameCountBeforeSnapshotRequest)
            .map((frame) => decodeTerminalStreamFrame(frame))
            .some((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotEnd)
        ).toBe(true)
      )
      const requestedSnapshotFrames = binaryFrames
        .slice(frameCountBeforeSnapshotRequest)
        .map((frame) => decodeTerminalStreamFrame(frame))
      const requestedSnapshotStart = requestedSnapshotFrames.find(
        (frame) => frame?.opcode === TerminalStreamOpcode.SnapshotStart
      )
      expect(
        requestedSnapshotStart && decodeTerminalStreamJson(requestedSnapshotStart.payload)
      ).toMatchObject({
        requestId: 7
      })
      expect(runtime.serializeTerminalBuffer).toHaveBeenLastCalledWith('pty-1', {
        scrollbackRows: 5000
      })
      expect(
        requestedSnapshotFrames
          .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
          .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
          .join('')
      ).toBe('snapshot')

      runtime.cleanupSubscription('terminal-multiplex:conn-1')
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes multibyte live output when encoded bytes reach the batch budget', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
      const handlers = new Map<
        number,
        (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
      >()
      const cleanups = new Map<string, () => void>()
      const dataListenerRef: {
        current?: (data: string, meta?: { seq?: number; rawLength?: number }) => void
      } = {}
      const runtime = stubRuntime({
        resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi.fn().mockResolvedValue({
          data: 'snapshot',
          cols: 120,
          rows: 40
        }),
        getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
        getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
        getLayout: vi.fn().mockReturnValue({ seq: 1 }),
        subscribeToTerminalData: vi.fn(
          (
            _: string,
            listener: (data: string, meta?: { seq?: number; rawLength?: number }) => void
          ) => {
            dataListenerRef.current = listener
            return vi.fn()
          }
        ),
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
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.multiplex', {}),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-multibyte-output-batch',
          sendBinary: (bytes) => binaryFrames.push(bytes),
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
              streamId: 6,
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
      binaryFrames.splice(0)

      const multibyteOutput = '界'.repeat(22_000)
      dataListenerRef.current?.(multibyteOutput, {
        seq: multibyteOutput.length,
        rawLength: multibyteOutput.length
      })

      const outputFrames = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
      expect(outputFrames.length).toBeGreaterThan(1)
      expect(outputFrames.every((frame) => (frame?.payload.byteLength ?? 0) <= 48 * 1024)).toBe(
        true
      )
      expect(outputFrames.map((frame) => frame?.seq)).toEqual([16_384, 22_000])
      expect(
        outputFrames.map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : '')).join('')
      ).toBe(multibyteOutput)

      cleanups.get('terminal-multiplex:conn-multibyte-output-batch')?.()
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks multiplex fallback snapshots truncated when the uncursored read is limited', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi
        .fn()
        .mockResolvedValue({ tail: ['line 120'], truncated: false, limited: true }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue(null),
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
      cleanupSubscription: vi.fn((id: string) => {
        const cleanup = cleanups.get(id)
        cleanups.delete(id)
        cleanup?.()
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      sendTerminal: vi.fn().mockResolvedValue({ accepted: true })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-multiplex-limited',
        sendBinary: (bytes) => binaryFrames.push(bytes),
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
            streamId: 11,
            terminal: 'terminal-1',
            client: { id: 'desktop-1', type: 'desktop' }
          })
        })
      )!
    )

    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
    )
    const subscribed = messages
      .map((msg) => JSON.parse(msg).result)
      .find((result) => result?.type === 'subscribed')
    expect(subscribed).toMatchObject({
      type: 'subscribed',
      streamId: 11,
      truncated: true
    })

    const decodedFrames = binaryFrames.map((frame) => decodeTerminalStreamFrame(frame))
    const snapshotStart = decodedFrames.find(
      (frame) => frame?.opcode === TerminalStreamOpcode.SnapshotStart && frame.streamId === 11
    )
    expect(snapshotStart && decodeTerminalStreamJson(snapshotStart.payload)).toMatchObject({
      truncated: true
    })
    const snapshotData = decodedFrames
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
      .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
      .join('')
    expect(snapshotData).toBe('line 120\r\n')

    runtime.cleanupSubscription('terminal-multiplex:conn-multiplex-limited')
    await dispatchPromise
  })

  it('falls back to smaller requested snapshots when serialized data exceeds the send budget', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi
        .fn()
        .mockResolvedValueOnce({ data: 'initial', cols: 120, rows: 40 })
        .mockResolvedValueOnce({ data: 'x'.repeat(2 * 1024 * 1024 + 1), cols: 120, rows: 40 })
        .mockResolvedValueOnce({ data: 'budgeted snapshot', cols: 120, rows: 40 }),
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
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-budgeted-request',
        sendBinary: (bytes) => binaryFrames.push(bytes),
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
          payload: encodeTerminalStreamJson({ requestId: 55, scrollbackRows: 5000 })
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

  it('drops desktop multiplex input while a mobile client owns the terminal floor', async () => {
    const messages: string[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue(null),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
      getTerminalFitOverride: vi.fn().mockReturnValue({
        mode: 'mobile-fit',
        cols: 49,
        rows: 20
      }),
      getDriver: vi.fn().mockReturnValue({ kind: 'mobile', clientId: 'phone-1' }),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
      updateDesktopViewport: vi.fn().mockResolvedValue(true)
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-locked',
        sendBinary: vi.fn(),
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
            client: { id: 'desktop-1', type: 'desktop' },
            viewport: { cols: 120, rows: 40 }
          })
        })
      )!
    )
    await vi.waitFor(() => expect(handlers.has(7)).toBe(true))
    await vi.waitFor(() =>
      expect(messages.map((msg) => JSON.parse(msg).result)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'fit-override-changed',
            streamId: 7,
            mode: 'mobile-fit',
            cols: 49,
            rows: 20
          }),
          expect.objectContaining({
            type: 'driver-changed',
            streamId: 7,
            driver: { kind: 'mobile', clientId: 'phone-1' }
          })
        ])
      )
    )

    handlers.get(7)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          streamId: 7,
          seq: 2,
          payload: encodeTerminalStreamText('typed while locked')
        })
      )!
    )

    expect(runtime.sendTerminal).not.toHaveBeenCalled()
    cleanups.get('terminal-multiplex:conn-locked')?.()
    await dispatchPromise
  })

  it('preserves LF input frames before writing to the multiplexed PTY', async () => {
    const messages: string[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue(null),
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
      cleanupSubscription: vi.fn((id: string) => {
        const cleanup = cleanups.get(id)
        cleanups.delete(id)
        cleanup?.()
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
      updateDesktopViewport: vi.fn().mockResolvedValue(true)
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-byte-preserving',
        sendBinary: vi.fn(),
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
            terminal: 'terminal-1',
            client: { id: 'desktop-1', type: 'desktop' }
          })
        })
      )!
    )
    await vi.waitFor(() => expect(handlers.has(9)).toBe(true))

    handlers.get(9)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          streamId: 9,
          seq: 2,
          payload: encodeTerminalStreamText('echo one\necho two\r\n')
        })
      )!
    )

    await vi.waitFor(() =>
      expect(runtime.sendTerminal).toHaveBeenCalledWith('terminal-1', {
        text: 'echo one\necho two\r\n',
        enter: false,
        interrupt: false
      })
    )

    runtime.cleanupSubscription('terminal-multiplex:conn-byte-preserving')
    await dispatchPromise
  })

  it('preserves LF input frames before writing to the subscribed PTY', async () => {
    const messages: string[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue(null),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      cleanupSubscription: vi.fn((id: string) => {
        const cleanup = cleanups.get(id)
        cleanups.delete(id)
        cleanup?.()
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
      updateDesktopViewport: vi.fn().mockResolvedValue(true)
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', {
        terminal: 'terminal-1',
        client: { id: 'desktop-1', type: 'desktop' },
        capabilities: { terminalBinaryStream: 1 }
      }),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-subscribe-byte-preserving',
        sendBinary: vi.fn(),
        registerBinaryStreamHandler: (streamId, handler) => {
          handlers.set(streamId, handler)
          return () => handlers.delete(streamId)
        }
      }
    )

    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
    )
    const streamId = JSON.parse(
      messages.find((msg) => JSON.parse(msg).result?.type === 'subscribed')!
    ).result.streamId as number
    handlers.get(streamId)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          streamId,
          seq: 1,
          payload: encodeTerminalStreamText('printf a\nprintf b\r\n')
        })
      )!
    )

    await vi.waitFor(() =>
      expect(runtime.sendTerminal).toHaveBeenCalledWith('terminal-1', {
        text: 'printf a\nprintf b\r\n',
        enter: false,
        interrupt: false
      })
    )

    runtime.cleanupSubscription('terminal-1:desktop-1')
    await dispatchPromise
  })

  it('bounds oversized live output frames for subscribed binary streams', async () => {
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
      const runtime = stubRuntime({
        resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi.fn().mockResolvedValue({
          data: 'snapshot',
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
        getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
        registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
          cleanups.set(id, cleanup)
        }),
        cleanupSubscription: vi.fn((id: string) => {
          const cleanup = cleanups.get(id)
          cleanups.delete(id)
          cleanup?.()
        }),
        waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
        sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
        updateDesktopViewport: vi.fn().mockResolvedValue(true)
      })
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.subscribe', {
          terminal: 'terminal-1',
          client: { id: 'desktop-1', type: 'desktop' },
          capabilities: { terminalBinaryStream: 1 }
        }),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-subscribe-output-chunking',
          sendBinary: (bytes) => binaryFrames.push(bytes),
          registerBinaryStreamHandler: (streamId, handler) => {
            handlers.set(streamId, handler)
            return () => handlers.delete(streamId)
          }
        }
      )

      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
      )
      binaryFrames.splice(0)

      const output = 'output-line\n'.repeat(8_000)
      dataListenerRef.current?.(output)

      const outputFrames = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
      expect(outputFrames.length).toBeGreaterThan(1)
      expect(outputFrames.every((frame) => (frame?.payload.byteLength ?? 0) <= 48 * 1024)).toBe(
        true
      )
      expect(
        outputFrames.map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : '')).join('')
      ).toBe(output)

      runtime.cleanupSubscription('terminal-1:desktop-1')
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })

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
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: null }),
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
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        signal: controller.signal,
        connectionId: 'conn-phone-multiplex',
        sendBinary: (bytes) => binaryFrames.push(bytes),
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
    expect(runtime.waitForLeafPtyId).toHaveBeenCalledWith('terminal-1', 10_000, controller.signal)

    controller.abort()
    await Promise.resolve()
    await Promise.resolve()

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

  it('bounds live output queued while a multiplex snapshot is loading', async () => {
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
      let resolveSnapshot: (value: { data: string; cols: number; rows: number }) => void = () => {}
      const runtime = stubRuntime({
        resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi.fn(
          () =>
            new Promise<{ data: string; cols: number; rows: number }>((resolve) => {
              resolveSnapshot = resolve
            })
        ),
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
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.multiplex', {}),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-buffered',
          sendBinary: (bytes) => binaryFrames.push(bytes),
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
              terminal: 'terminal-1',
              client: { id: 'desktop-1', type: 'desktop' },
              viewport: { cols: 120, rows: 40 }
            })
          })
        )!
      )
      await vi.waitFor(() => expect(dataListenerRef.current).toBeDefined())

      for (let index = 0; index < 400; index += 1) {
        dataListenerRef.current?.(`${String(index).padStart(3, '0')}${'x'.repeat(1021)}`)
      }
      await vi.waitFor(() => expect(runtime.serializeTerminalBuffer).toHaveBeenCalled())
      resolveSnapshot({ data: '', cols: 120, rows: 40 })
      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
      )
      await vi.runOnlyPendingTimersAsync()

      const output = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
      expect(output.length).toBeLessThanOrEqual(256 * 1024)
      expect(output).not.toContain('000')
      expect(output).toContain('399')

      cleanups.get('terminal-multiplex:conn-buffered')?.()
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds multibyte live output by encoded bytes while a multiplex snapshot is loading', async () => {
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
      let resolveSnapshot: (value: { data: string; cols: number; rows: number }) => void = () => {}
      const runtime = stubRuntime({
        resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi.fn(
          () =>
            new Promise<{ data: string; cols: number; rows: number }>((resolve) => {
              resolveSnapshot = resolve
            })
        ),
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
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.multiplex', {}),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-buffered-multibyte',
          sendBinary: (bytes) => binaryFrames.push(bytes),
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
              streamId: 10,
              terminal: 'terminal-1',
              client: { id: 'desktop-1', type: 'desktop' },
              viewport: { cols: 120, rows: 40 }
            })
          })
        )!
      )
      await vi.waitFor(() => expect(dataListenerRef.current).toBeDefined())

      for (let index = 0; index < 400; index += 1) {
        dataListenerRef.current?.(`${String(index).padStart(3, '0')}${'界'.repeat(341)}`)
      }
      await vi.waitFor(() => expect(runtime.serializeTerminalBuffer).toHaveBeenCalled())
      resolveSnapshot({ data: '', cols: 120, rows: 40 })
      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
      )
      await vi.runOnlyPendingTimersAsync()

      const output = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
      expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(256 * 1024)
      expect(output).not.toContain('000')
      expect(output).toContain('399')

      cleanups.get('terminal-multiplex:conn-buffered-multibyte')?.()
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
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
        resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
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
          .mockResolvedValueOnce({ data: 'retry snapshot', cols: 120, rows: 40 }),
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
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.multiplex', {}),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-request-overflow',
          sendBinary: (bytes) => binaryFrames.push(bytes),
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
            payload: encodeTerminalStreamJson({ requestId: 44, scrollbackRows: 5000 })
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
