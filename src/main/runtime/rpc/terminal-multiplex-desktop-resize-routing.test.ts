import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
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
import { makeRequest, stubRuntime } from './terminal-multiplex-test-harness'

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
        serializeAuthoritativeTerminalBuffer: vi.fn().mockResolvedValue({
          data: 'authoritative snapshot',
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
              viewport: { cols: 300, rows: 150 },
              capabilities: { desktopViewportClaims: 1 }
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
      expect(runtime.updateRemoteDesktopViewer).toHaveBeenCalledWith(
        'pty-1',
        'multiplex:conn-1:5',
        'desktop-1',
        300,
        150,
        false
      )
      expect(handlers.has(5)).toBe(true)

      let releaseClaim = (): void => {}
      vi.mocked(runtime.updateRemoteDesktopViewer).mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            releaseClaim = () => resolve(true)
          })
      )

      handlers.get(5)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.ClaimViewport,
            streamId: 5,
            seq: 0,
            payload: encodeTerminalStreamJson({ cols: 96, rows: 32 })
          })
        )!
      )
      await vi.waitFor(() =>
        expect(runtime.updateRemoteDesktopViewer).toHaveBeenLastCalledWith(
          'pty-1',
          'multiplex:conn-1:5',
          'desktop-1',
          96,
          32,
          true
        )
      )
      handlers.get(5)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Resize,
            streamId: 5,
            seq: 1,
            payload: encodeTerminalStreamJson({ cols: 96, rows: 32 })
          })
        )!
      )
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
      expect(runtime.sendTerminal).not.toHaveBeenCalled()
      expect(runtime.updateRemoteDesktopViewer).not.toHaveBeenLastCalledWith(
        'pty-1',
        'multiplex:conn-1:5',
        'desktop-1',
        96,
        32,
        false
      )
      releaseClaim()
      await vi.waitFor(() =>
        expect(runtime.updateRemoteDesktopViewer).toHaveBeenLastCalledWith(
          'pty-1',
          'multiplex:conn-1:5',
          'desktop-1',
          96,
          32,
          false
        )
      )
      await vi.waitFor(() =>
        expect(runtime.sendTerminal).toHaveBeenCalledWith('terminal-1', {
          text: 'ls\r',
          enter: false,
          interrupt: false
        })
      )
      const sentAfterSuccessfulClaim = vi.mocked(runtime.sendTerminal).mock.calls.length
      vi.mocked(runtime.updateRemoteDesktopViewer).mockResolvedValueOnce(false)
      for (const [opcode, seq, payload] of [
        [TerminalStreamOpcode.ClaimViewport, 3, encodeTerminalStreamJson({ cols: 88, rows: 28 })],
        [TerminalStreamOpcode.Resize, 4, encodeTerminalStreamJson({ cols: 88, rows: 28 })],
        [TerminalStreamOpcode.Input, 5, encodeTerminalStreamText('blocked')]
      ] as const) {
        handlers.get(5)?.(
          decodeTerminalStreamFrame(
            encodeTerminalStreamFrame({ opcode, streamId: 5, seq, payload })
          )!
        )
      }
      await vi.waitFor(() =>
        expect(runtime.updateRemoteDesktopViewer).toHaveBeenLastCalledWith(
          'pty-1',
          'multiplex:conn-1:5',
          'desktop-1',
          88,
          28,
          false
        )
      )
      expect(runtime.sendTerminal).toHaveBeenCalledTimes(sentAfterSuccessfulClaim)
      for (const [opcode, seq, payload] of [
        [TerminalStreamOpcode.ClaimViewport, 6, encodeTerminalStreamJson({ cols: 88, rows: 28 })],
        [TerminalStreamOpcode.Resize, 7, encodeTerminalStreamJson({ cols: 88, rows: 28 })],
        [TerminalStreamOpcode.Input, 8, encodeTerminalStreamText('retry')]
      ] as const) {
        handlers.get(5)?.(
          decodeTerminalStreamFrame(
            encodeTerminalStreamFrame({ opcode, streamId: 5, seq, payload })
          )!
        )
      }
      await vi.waitFor(() =>
        expect(runtime.sendTerminal).toHaveBeenLastCalledWith('terminal-1', {
          text: 'retry',
          enter: false,
          interrupt: false
        })
      )

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
            opcode: TerminalStreamOpcode.Resize,
            streamId: 5,
            seq: 3,
            payload: encodeTerminalStreamJson({ cols: 100, rows: 30 })
          })
        )!
      )
      await vi.waitFor(() =>
        expect(runtime.updateRemoteDesktopViewer).toHaveBeenLastCalledWith(
          'pty-1',
          'multiplex:conn-1:5',
          'desktop-1',
          100,
          30,
          false
        )
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
      expect(runtime.serializeTerminalBuffer).toHaveBeenCalledWith('pty-1', {
        scrollbackRows: 0
      })
      expect(runtime.serializeAuthoritativeTerminalBuffer).toHaveBeenLastCalledWith('pty-1', {
        scrollbackRows: 5000
      })
      expect(
        requestedSnapshotFrames
          .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
          .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
          .join('')
      ).toBe('authoritative snapshot')

      // A viewport-less stream is passive: it must neither register nor later
      // release the active stream's width floor when the connection closes.
      handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: 5,
            payload: encodeTerminalStreamJson({
              streamId: 6,
              terminal: 'terminal-1',
              client: { id: 'desktop-1', type: 'desktop' }
            })
          })
        )!
      )
      await vi.waitFor(() =>
        expect(
          messages.some(
            (msg) =>
              JSON.parse(msg).result?.type === 'subscribed' &&
              JSON.parse(msg).result?.streamId === 6
          )
        ).toBe(true)
      )

      // A second active floor on the same PTY is released in the same batch,
      // keeping connection teardown to one registry recomputation per PTY.
      handlers.get(0)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Subscribe,
            streamId: 0,
            seq: 6,
            payload: encodeTerminalStreamJson({
              streamId: 7,
              terminal: 'terminal-1',
              client: { id: 'desktop-2', type: 'desktop' },
              viewport: { cols: 90, rows: 30 }
            })
          })
        )!
      )
      await vi.waitFor(() =>
        expect(
          messages.some(
            (msg) =>
              JSON.parse(msg).result?.type === 'subscribed' &&
              JSON.parse(msg).result?.streamId === 7
          )
        ).toBe(true)
      )

      runtime.cleanupSubscription('terminal-multiplex:conn-1')
      await dispatchPromise
      expect(runtime.unregisterRemoteDesktopViewer).not.toHaveBeenCalled()
      expect(runtime.unregisterRemoteDesktopViewers).toHaveBeenCalledTimes(1)
      expect(runtime.unregisterRemoteDesktopViewers).toHaveBeenCalledWith('pty-1', [
        'multiplex:conn-1:5',
        'multiplex:conn-1:7'
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('applies a viewer resize parked during a snapshot-request buffering window', async () => {
    vi.useFakeTimers()
    try {
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
          .mockResolvedValue({ data: 'snapshot', cols: 120, rows: 40 }),
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
          connectionId: 'conn-snap',
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
              viewport: { cols: 300, rows: 150 },
              capabilities: { desktopViewportClaims: 1 }
            })
          })
        )!
      )
      await vi.waitFor(() =>
        expect(messages.some((msg) => JSON.parse(msg).result?.type === 'subscribed')).toBe(true)
      )
      // Ignore the subscribe-time floor registration; assert only the drained one.
      vi.mocked(runtime.updateRemoteDesktopViewer).mockClear()

      // A snapshot request opens the buffering window synchronously (buffering
      // is set before the first await inside the handler)...
      handlers.get(9)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.SnapshotRequest,
            streamId: 9,
            seq: 2,
            payload: encodeTerminalStreamJson({ requestId: 3, scrollbackRows: 1000 })
          })
        )!
      )
      // ...so a resize arriving now is PARKED, not applied inline.
      handlers.get(9)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Resize,
            streamId: 9,
            seq: 3,
            payload: encodeTerminalStreamJson({ cols: 88, rows: 33 })
          })
        )!
      )
      expect(runtime.updateRemoteDesktopViewer).not.toHaveBeenCalled()

      // Once the snapshot completes and buffering clears, the parked resize is
      // drained (previously it was silently dropped until the next resize).
      await vi.waitFor(() =>
        expect(runtime.updateRemoteDesktopViewer).toHaveBeenCalledWith(
          'pty-1',
          'multiplex:conn-snap:9',
          'desktop-1',
          88,
          33,
          false
        )
      )

      runtime.cleanupSubscription('terminal-multiplex:conn-snap')
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits a resize drained after the initial snapshot', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const cleanups = new Map<string, () => void>()
    let resolveSnapshot = (_value: { data: string; cols: number; rows: number }): void => {}
    let resizeListener:
      | ((event: {
          cols: number
          rows: number
          displayMode: string
          reason: string
          seq?: number
        }) => void)
      | undefined
    const updateRemoteDesktopViewer = vi.fn(
      async (_ptyId: string, _key: string, _clientId: string, cols: number, rows: number) => {
        if (updateRemoteDesktopViewer.mock.calls.length > 1) {
          resizeListener?.({ cols, rows, displayMode: 'desktop', reason: 'apply-layout', seq: 2 })
        }
        return true
      }
    )
    const runtime = stubRuntime({
      updateRemoteDesktopViewer,
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn(
        () =>
          new Promise<{ data: string; cols: number; rows: number }>((resolve) => {
            resolveSnapshot = resolve
          })
      ),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToTerminalResize: vi.fn((_ptyId, listener) => {
        resizeListener = listener
        return vi.fn()
      }),
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
        connectionId: 'conn-initial-resize',
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
            viewport: { cols: 80, rows: 24 }
          })
        })
      )!
    )
    await vi.waitFor(() => expect(runtime.serializeTerminalBuffer).toHaveBeenCalled())
    handlers.get(9)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Resize,
          streamId: 9,
          seq: 2,
          payload: encodeTerminalStreamJson({ cols: 132, rows: 43 })
        })
      )!
    )
    expect(updateRemoteDesktopViewer).toHaveBeenCalledTimes(1)

    resolveSnapshot({ data: 'snapshot', cols: 80, rows: 24 })
    await vi.waitFor(() =>
      expect(
        binaryFrames.some(
          (bytes) => decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.Resized
        )
      ).toBe(true)
    )
    const opcodes = binaryFrames.map((bytes) => decodeTerminalStreamFrame(bytes)?.opcode)
    expect(opcodes.indexOf(TerminalStreamOpcode.Resized)).toBeGreaterThan(
      opcodes.indexOf(TerminalStreamOpcode.SnapshotEnd)
    )

    runtime.cleanupSubscription('terminal-multiplex:conn-initial-resize')
    await dispatchPromise
  })
})
