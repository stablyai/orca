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
    // Why: every multiplex stream registers as a remote view subscriber for
    // Phase-5 query-authority suppression (terminal-query-authority.md).
    registerRemoteTerminalViewSubscriber: () => () => {},
    // Why: the multiplex subscribe path resolves handles via
    // resolveLiveLeafForHandle (#7718). Default to a live pty so tests that
    // only stub the legacy resolveLeafForHandle still bind; tests that need a
    // null/stale leaf override this explicitly.
    resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
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
        resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
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
      const dispatcher = new RpcDispatcher({
        runtime,
        methods: TERMINAL_METHODS
      })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.multiplex', {}),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-1',
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
            payload: encodeTerminalStreamJson({
              requestId: 7,
              scrollbackRows: 5000
            })
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

  it('drops stale mobile resize re-stream completions for multiplex streams', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    let resizeListener:
      | ((event: {
          cols: number
          rows: number
          displayMode: string
          reason: string
          seq: number
        }) => void)
      | undefined
    const restreamResolves: ((value: { data: string; cols: number; rows: number }) => void)[] = []
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi
        .fn()
        .mockResolvedValueOnce({ data: 'initial', cols: 80, rows: 24 })
        .mockImplementation(
          () =>
            new Promise<{ data: string; cols: number; rows: number }>((resolve) => {
              restreamResolves.push(resolve)
            })
        ),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
      handleMobileSubscribe: vi.fn().mockResolvedValue(undefined),
      handleMobileUnsubscribe: vi.fn(),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToTerminalResize: vi.fn((_, listener) => {
        resizeListener = listener as typeof resizeListener
        return vi.fn()
      }),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
      getTerminalFitOverride: vi.fn().mockReturnValue(null),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
      updateMobileViewport: vi.fn().mockResolvedValue({ updated: true, applied: true })
    })
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: TERMINAL_METHODS
    })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-stale-multiplex-resize',
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
            streamId: 5,
            terminal: 'terminal-1',
            client: { id: 'phone-1', type: 'mobile' }
          })
        })
      )!
    )

    await vi.waitFor(() => expect(resizeListener).toBeDefined())
    binaryFrames.splice(0)

    resizeListener?.({
      cols: 90,
      rows: 24,
      displayMode: 'auto',
      reason: 'apply-layout',
      seq: 2
    })
    resizeListener?.({
      cols: 100,
      rows: 24,
      displayMode: 'auto',
      reason: 'apply-layout',
      seq: 3
    })
    await vi.waitFor(() => expect(restreamResolves).toHaveLength(2))

    restreamResolves[1]?.({ data: 'newer', cols: 100, rows: 24 })
    await vi.waitFor(() =>
      expect(
        binaryFrames.some((frame) => {
          const decoded = decodeTerminalStreamFrame(frame)
          return (
            decoded?.opcode === TerminalStreamOpcode.SnapshotChunk &&
            decodeTerminalStreamText(decoded.payload) === 'newer'
          )
        })
      ).toBe(true)
    )
    restreamResolves[0]?.({ data: 'older', cols: 90, rows: 24 })
    await Promise.resolve()
    await Promise.resolve()

    const snapshotData = binaryFrames
      .map((frame) => decodeTerminalStreamFrame(frame))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
      .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
    expect(snapshotData).toEqual(['newer'])

    cleanups.get('terminal-multiplex:conn-stale-multiplex-resize')?.()
    await dispatchPromise
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
        resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
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
      const dispatcher = new RpcDispatcher({
        runtime,
        methods: TERMINAL_METHODS
      })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.multiplex', {}),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-multibyte-output-batch',
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
      const encodeSpy = vi.spyOn(TextEncoder.prototype, 'encode')
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
      expect(encodeSpy).not.toHaveBeenCalledWith(multibyteOutput)
      encodeSpy.mockRestore()

      cleanups.get('terminal-multiplex:conn-multibyte-output-batch')?.()
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds ACK-capable multiplex output over budget until the client acknowledges bytes', async () => {
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
        connectionId: 'conn-ack-gated',
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
            streamId: 16,
            terminal: 'terminal-1',
            client: { id: 'desktop-1', type: 'desktop' },
            viewport: { cols: 120, rows: 40 },
            capabilities: { ackOutput: 1 }
          })
        })
      )!
    )
    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
    )
    binaryFrames.splice(0)

    const output = 'x'.repeat(700 * 1024)
    dataListenerRef.current?.(output, { seq: output.length, rawLength: output.length })

    const initialOutputFrames = binaryFrames
      .map((frame) => decodeTerminalStreamFrame(frame))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
    const initialBytes = initialOutputFrames.reduce(
      (total, frame) => total + (frame?.payload.byteLength ?? 0),
      0
    )
    expect(initialBytes).toBeLessThanOrEqual(512 * 1024)
    expect(initialOutputFrames.length).toBeGreaterThan(0)
    const initialOutput = initialOutputFrames
      .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
      .join('')
    expect(initialOutput.length).toBeLessThan(output.length)

    handlers.get(16)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          streamId: 16,
          seq: 2,
          payload: encodeTerminalStreamText('still interactive\r')
        })
      )!
    )
    await vi.waitFor(() =>
      expect(runtime.sendTerminal).toHaveBeenCalledWith('terminal-1', {
        text: 'still interactive\r',
        enter: false,
        interrupt: false
      })
    )

    handlers.get(16)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Ack,
          streamId: 16,
          seq: 3,
          payload: encodeTerminalStreamJson({ bytes: initialBytes })
        })
      )!
    )

    const flushedOutputFrames = binaryFrames
      .map((frame) => decodeTerminalStreamFrame(frame))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
    expect(flushedOutputFrames.length).toBeGreaterThan(initialOutputFrames.length)

    runtime.cleanupSubscription('terminal-multiplex:conn-ack-gated')
    await dispatchPromise
  })

  it('releases shared ACK budget to other stalled multiplex streams', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    const dataListeners = new Map<
      string,
      (data: string, meta?: { seq?: number; rawLength?: number }) => void
    >()
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn((terminal: string) => ({
        ptyId: terminal.replace('terminal-', 'pty-')
      })),
      resolveLiveLeafForHandle: vi.fn((terminal: string) => ({
        ptyId: terminal.replace('terminal-', 'pty-')
      })),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn(async (ptyId: string) => ({
        data: `snapshot-${ptyId}`,
        cols: 120,
        rows: 40
      })),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn(
        (
          ptyId: string,
          listener: (data: string, meta?: { seq?: number; rawLength?: number }) => void
        ) => {
          dataListeners.set(ptyId, listener)
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
        connectionId: 'conn-ack-shared-budget',
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

    const streamIds = [21, 22, 23, 24, 25, 26]
    for (const streamId of streamIds) {
      handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: streamId,
            payload: encodeTerminalStreamJson({
              streamId,
              terminal: `terminal-${streamId - 20}`,
              client: { id: `desktop-${streamId}`, type: 'desktop' },
              viewport: { cols: 120, rows: 40 },
              capabilities: { ackOutput: 1 }
            })
          })
        )!
      )
    }

    await vi.waitFor(() =>
      expect(
        messages
          .map((msg) => JSON.parse(msg).result)
          .filter((result) => result?.type === 'subscribed')
      ).toHaveLength(streamIds.length)
    )
    await vi.waitFor(() => expect(dataListeners.size).toBe(streamIds.length))
    binaryFrames.splice(0)

    const fillerOutput = 'f'.repeat(480 * 1024)
    for (let index = 1; index <= 4; index += 1) {
      dataListeners.get(`pty-${index}`)?.(fillerOutput, {
        seq: fillerOutput.length,
        rawLength: fillerOutput.length
      })
    }
    const stalledOutput = 's'.repeat(700 * 1024)
    dataListeners.get('pty-5')?.(stalledOutput, {
      seq: stalledOutput.length,
      rawLength: stalledOutput.length
    })
    dataListeners.get('pty-6')?.(stalledOutput, {
      seq: stalledOutput.length,
      rawLength: stalledOutput.length
    })

    const initialOutputFrames = binaryFrames
      .map((frame) => decodeTerminalStreamFrame(frame))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
    const initialBytesByStream = new Map<number, number>()
    for (const frame of initialOutputFrames) {
      if (!frame) {
        continue
      }
      initialBytesByStream.set(
        frame.streamId,
        (initialBytesByStream.get(frame.streamId) ?? 0) + frame.payload.byteLength
      )
    }
    const initialBytes = initialOutputFrames.reduce(
      (total, frame) => total + (frame?.payload.byteLength ?? 0),
      0
    )
    expect(initialBytes).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(initialBytesByStream.get(21)).toBe(480 * 1024)
    expect(initialBytesByStream.get(22)).toBe(480 * 1024)
    expect(initialBytesByStream.get(23)).toBe(480 * 1024)
    expect(initialBytesByStream.get(24)).toBe(480 * 1024)
    expect(initialBytesByStream.get(25)).toBeGreaterThan(0)
    expect(initialBytesByStream.get(26) ?? 0).toBe(0)

    handlers.get(26)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          streamId: 26,
          seq: 200,
          payload: encodeTerminalStreamText('remote-still-interactive\r')
        })
      )!
    )
    await vi.waitFor(() =>
      expect(runtime.sendTerminal).toHaveBeenCalledWith('terminal-6', {
        text: 'remote-still-interactive\r',
        enter: false,
        interrupt: false
      })
    )

    const frameCountBeforeAck = binaryFrames.length
    handlers.get(21)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Ack,
          streamId: 21,
          seq: 201,
          payload: encodeTerminalStreamJson({ bytes: initialBytesByStream.get(21) ?? 0 })
        })
      )!
    )

    await vi.waitFor(() =>
      expect(
        binaryFrames
          .slice(frameCountBeforeAck)
          .map((frame) => decodeTerminalStreamFrame(frame))
          .some((frame) => {
            if (frame?.streamId !== 25 || frame.opcode !== TerminalStreamOpcode.SnapshotStart) {
              return false
            }
            const payload = decodeTerminalStreamJson<{ reason?: string }>(frame.payload)
            return payload?.reason === 'ack-pending-overflow'
          })
      ).toBe(true)
    )
    const framesAfterAck = binaryFrames
      .slice(frameCountBeforeAck)
      .map((frame) => decodeTerminalStreamFrame(frame))
    const snapshotStartIndex = framesAfterAck.findIndex((frame) => {
      if (frame?.streamId !== 25 || frame.opcode !== TerminalStreamOpcode.SnapshotStart) {
        return false
      }
      const payload = decodeTerminalStreamJson<{ reason?: string }>(frame.payload)
      return payload?.reason === 'ack-pending-overflow'
    })
    const outputFramesAfterAck = framesAfterAck.filter(
      (frame) => frame?.opcode === TerminalStreamOpcode.Output
    )
    const bytesAfterAckByStream = new Map<number, number>()
    for (const frame of outputFramesAfterAck) {
      if (!frame) {
        continue
      }
      bytesAfterAckByStream.set(
        frame.streamId,
        (bytesAfterAckByStream.get(frame.streamId) ?? 0) + frame.payload.byteLength
      )
    }
    expect(snapshotStartIndex).toBeGreaterThanOrEqual(0)
    expect(
      framesAfterAck
        .filter((frame) => frame?.streamId === 25 && frame.opcode === TerminalStreamOpcode.Output)
        .every((frame) => framesAfterAck.indexOf(frame) > snapshotStartIndex)
    ).toBe(true)
    expect(bytesAfterAckByStream.get(25) ?? 0).toBeGreaterThan(0)
    expect(bytesAfterAckByStream.get(21) ?? 0).toBe(0)
    expect(
      outputFramesAfterAck.reduce((total, frame) => total + (frame?.payload.byteLength ?? 0), 0)
    ).toBeLessThanOrEqual(initialBytesByStream.get(21) ?? 0)

    runtime.cleanupSubscription('terminal-multiplex:conn-ack-shared-budget')
    await dispatchPromise
  })

  it('caps stalled ACK output and snapshots before resuming retained tail frames', async () => {
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
      serializeTerminalBuffer: vi
        .fn()
        .mockResolvedValueOnce({ data: 'initial snapshot', cols: 120, rows: 40 })
        .mockResolvedValue({ data: 'recovered snapshot', cols: 120, rows: 40, seq: 99 }),
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
        connectionId: 'conn-ack-overflow',
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
            streamId: 17,
            terminal: 'terminal-1',
            client: { id: 'desktop-1', type: 'desktop' },
            viewport: { cols: 120, rows: 40 },
            capabilities: { ackOutput: 1 }
          })
        })
      )!
    )
    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
    )
    binaryFrames.splice(0)

    const output = 'x'.repeat(3 * 1024 * 1024)
    dataListenerRef.current?.(output, { seq: output.length, rawLength: output.length })

    const initialOutputFrames = binaryFrames
      .map((frame) => decodeTerminalStreamFrame(frame))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
    const initialBytes = initialOutputFrames.reduce(
      (total, frame) => total + (frame?.payload.byteLength ?? 0),
      0
    )
    expect(initialBytes).toBeLessThanOrEqual(512 * 1024)

    handlers.get(17)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          streamId: 17,
          seq: 2,
          payload: encodeTerminalStreamText('still interactive\r')
        })
      )!
    )
    await vi.waitFor(() =>
      expect(runtime.sendTerminal).toHaveBeenCalledWith('terminal-1', {
        text: 'still interactive\r',
        enter: false,
        interrupt: false
      })
    )

    binaryFrames.splice(0)
    handlers.get(17)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Ack,
          streamId: 17,
          seq: 3,
          payload: encodeTerminalStreamJson({ bytes: initialBytes })
        })
      )!
    )

    await vi.waitFor(() =>
      expect(
        binaryFrames
          .map((frame) => decodeTerminalStreamFrame(frame))
          .some((frame) => {
            if (frame?.opcode !== TerminalStreamOpcode.SnapshotStart) {
              return false
            }
            const payload = decodeTerminalStreamJson<{ reason?: string }>(frame.payload)
            return payload?.reason === 'ack-pending-overflow'
          })
      ).toBe(true)
    )
    const drainFrames = binaryFrames.map((frame) => decodeTerminalStreamFrame(frame))
    const recoveryStartIndex = drainFrames.findIndex((frame) => {
      if (frame?.opcode !== TerminalStreamOpcode.SnapshotStart) {
        return false
      }
      const payload = decodeTerminalStreamJson<{ reason?: string }>(frame.payload)
      return payload?.reason === 'ack-pending-overflow'
    })
    const firstOutputAfterAckIndex = drainFrames.findIndex(
      (frame) => frame?.opcode === TerminalStreamOpcode.Output
    )
    expect(recoveryStartIndex).toBeGreaterThanOrEqual(0)
    // Why: clients discard truncated snapshots; a usable recovery snapshot
    // must not be marked truncated or the dropped output gap is permanent.
    expect(
      decodeTerminalStreamJson<{ truncated?: boolean }>(drainFrames[recoveryStartIndex]!.payload)
        ?.truncated
    ).toBe(false)
    expect(firstOutputAfterAckIndex).toBeGreaterThan(recoveryStartIndex)
    expect(
      drainFrames
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
    ).toBe('recovered snapshot')

    const outputBytesAfterRecovery = drainFrames
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
      .reduce((total, frame) => total + (frame?.payload.byteLength ?? 0), 0)
    expect(outputBytesAfterRecovery).toBeLessThanOrEqual(256 * 1024)

    runtime.cleanupSubscription('terminal-multiplex:conn-ack-overflow')
    await dispatchPromise
  })

  it('trims recovery-covered ACK pending output instead of replaying it', async () => {
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
    const floodedChars = 3 * 1024 * 1024
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi
        .fn()
        .mockResolvedValueOnce({ data: 'initial snapshot', cols: 120, rows: 40 })
        // Why: the recovery snapshot seq covers the entire flood, so every
        // retained pending chunk is already contained in the snapshot.
        .mockResolvedValue({ data: 'recovered snapshot', cols: 120, rows: 40, seq: floodedChars }),
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
        connectionId: 'conn-ack-trim',
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
            streamId: 31,
            terminal: 'terminal-1',
            client: { id: 'desktop-1', type: 'desktop' },
            viewport: { cols: 120, rows: 40 },
            capabilities: { ackOutput: 1 }
          })
        })
      )!
    )
    await vi.waitFor(() =>
      expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
    )
    binaryFrames.splice(0)

    const output = 'x'.repeat(floodedChars)
    dataListenerRef.current?.(output, { seq: floodedChars, rawLength: floodedChars })
    const initialBytes = binaryFrames
      .map((frame) => decodeTerminalStreamFrame(frame))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
      .reduce((total, frame) => total + (frame?.payload.byteLength ?? 0), 0)
    expect(initialBytes).toBeLessThanOrEqual(512 * 1024)

    binaryFrames.splice(0)
    handlers.get(31)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Ack,
          streamId: 31,
          seq: 2,
          payload: encodeTerminalStreamJson({ bytes: initialBytes })
        })
      )!
    )
    await vi.waitFor(() =>
      expect(
        binaryFrames
          .map((frame) => decodeTerminalStreamFrame(frame))
          .some((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotEnd)
      ).toBe(true)
    )

    const framesAfterRecovery = binaryFrames.map((frame) => decodeTerminalStreamFrame(frame))
    expect(
      framesAfterRecovery
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
    ).toBe('recovered snapshot')
    // Why: every retained chunk is covered by the recovery snapshot seq;
    // replaying any of them would duplicate snapshot content.
    expect(
      framesAfterRecovery.filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
    ).toEqual([])

    binaryFrames.splice(0)
    const fresh = 'fresh-after-recovery\r\n'
    dataListenerRef.current?.(fresh, {
      seq: floodedChars + fresh.length,
      rawLength: fresh.length
    })
    await vi.waitFor(() => {
      const freshOutput = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
      expect(freshOutput).toBe(fresh)
    })

    runtime.cleanupSubscription('terminal-multiplex:conn-ack-trim')
    await dispatchPromise
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
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({
        tail: ['line 120'],
        truncated: false,
        limited: true
      }),
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
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: TERMINAL_METHODS
    })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.multiplex', {}),
      (msg) => messages.push(msg),
      {
        connectionId: 'conn-multiplex-limited',
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

  it('drops desktop multiplex input while a mobile client owns the terminal floor', async () => {
    const messages: string[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    const runtime = stubRuntime({
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
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
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: TERMINAL_METHODS
    })

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
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
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
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: TERMINAL_METHODS
    })

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
          connectionId: 'conn-subscribe-output-chunking',
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

  it('flushes output buffered during initial multiplex snapshot once', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
      const cleanups = new Map<string, () => void>()
      const dataListenerRef: {
        current?: (data: string, meta?: { seq?: number; rawLength?: number }) => void
      } = {}
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
        subscribeToTerminalData: vi.fn((_: string, listener) => {
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
          connectionId: 'conn-buffered-output-on-subscribe',
          sendBinary: (bytes) => {
            binaryFrames.push(bytes)
          },
          registerBinaryStreamHandler: vi.fn(() => vi.fn())
        }
      )

      await vi.waitFor(() => expect(dataListenerRef.current).toBeDefined())
      dataListenerRef.current?.('starting shell\r\n', {
        seq: 16,
        rawLength: 16
      })
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
      expect(output).toBe('starting shell\r\n')

      runtime.cleanupSubscription('terminal-1:desktop-1')
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops buffered multiplex output already covered by the initial snapshot seq', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
      const cleanups = new Map<string, () => void>()
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
          connectionId: 'conn-buffered-output-covered-by-snapshot',
          sendBinary: (bytes) => {
            binaryFrames.push(bytes)
          },
          registerBinaryStreamHandler: vi.fn(() => vi.fn())
        }
      )

      await vi.waitFor(() => expect(dataListenerRef.current).toBeDefined())
      const startupLine = 'starting shell\r\n'
      dataListenerRef.current?.(startupLine, {
        seq: startupLine.length,
        rawLength: startupLine.length
      })
      resolveSnapshot({
        data: startupLine,
        cols: 120,
        rows: 40,
        seq: startupLine.length
      })
      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
      )
      await vi.runOnlyPendingTimersAsync()

      const outputFrames = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
      const snapshotStart = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .find((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotStart)
      expect(snapshotStart && decodeTerminalStreamJson(snapshotStart.payload)).toMatchObject({
        seq: startupLine.length
      })
      expect(outputFrames).toHaveLength(0)

      runtime.cleanupSubscription('terminal-1:desktop-1')
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('replays only buffered multiplex output not covered by the initial snapshot seq', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
      const cleanups = new Map<string, () => void>()
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
      const snapshotResolves: ((value: { data: string; cols: number; rows: number }) => void)[] = []
      const runtime = stubRuntime({
        resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi.fn(
          () =>
            new Promise<{ data: string; cols: number; rows: number }>((resolve) => {
              snapshotResolves.push(resolve)
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
      const dispatcher = new RpcDispatcher({
        runtime,
        methods: TERMINAL_METHODS
      })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.multiplex', {}),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-buffered',
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
      snapshotResolves.shift()?.({ data: '', cols: 120, rows: 40 })
      await vi.waitFor(() => expect(runtime.serializeTerminalBuffer).toHaveBeenCalledTimes(2))
      snapshotResolves.shift()?.({ data: '399', cols: 120, rows: 40 })
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
      expect(output).toBe('')
      const snapshotPayload = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
      expect(snapshotPayload).toBe('399')
      expect(output).not.toContain('000')

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
      const snapshotResolves: ((value: { data: string; cols: number; rows: number }) => void)[] = []
      const runtime = stubRuntime({
        resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi.fn(
          () =>
            new Promise<{ data: string; cols: number; rows: number }>((resolve) => {
              snapshotResolves.push(resolve)
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
      const dispatcher = new RpcDispatcher({
        runtime,
        methods: TERMINAL_METHODS
      })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.multiplex', {}),
        (msg) => messages.push(msg),
        {
          connectionId: 'conn-buffered-multibyte',
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
      snapshotResolves.shift()?.({ data: '', cols: 120, rows: 40 })
      await vi.waitFor(() => expect(runtime.serializeTerminalBuffer).toHaveBeenCalledTimes(2))
      snapshotResolves.shift()?.({ data: '399', cols: 120, rows: 40 })
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
      expect(output).toBe('')
      const snapshotPayload = binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
        .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
        .join('')
      expect(snapshotPayload).toBe('399')
      expect(output).not.toContain('000')

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
