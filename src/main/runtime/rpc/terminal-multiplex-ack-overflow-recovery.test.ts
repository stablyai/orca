import './unused-default-rpc-methods.test-fixture'
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
import {
  makeRequest,
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe,
  stubRuntime
} from './terminal-multiplex-test-harness'

describe('terminal multiplex RPC', () => {
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
      expect(runtime.sendTerminal).toHaveBeenCalledWith(
        'terminal-1',
        {
          text: 'still interactive\r',
          enter: false,
          interrupt: false
        },
        { inputKind: 'driving', inputSource: 'desktop' }
      )
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
    // Clients discard truncated snapshots; mark usable recovery complete or the gap stays permanent.
    expect(
      decodeTerminalStreamJson<{ truncated?: boolean }>(drainFrames[recoveryStartIndex]!.payload)
        ?.truncated
    ).toBe(false)
    // Recovery must replace history that ends before dropped output.
    expect(runtime.serializeTerminalBuffer).toHaveBeenLastCalledWith('pty-1', {
      scrollbackRows: 1000
    })
    expect(
      decodeTerminalStreamJson<{ scrollbackRows?: number }>(
        drainFrames[recoveryStartIndex]!.payload
      )?.scrollbackRows
    ).toBe(1000)
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

  it.each([
    {
      failure: 'throws',
      recover: () => Promise.reject(new Error('snapshot unavailable'))
    },
    {
      failure: 'returns no snapshot',
      recover: () => Promise.resolve(null)
    }
  ])('ends a stream when ACK overflow recovery serialization $failure', async ({ recover }) => {
    const dataListenerRef: {
      current?: (data: string, meta?: { seq?: number; rawLength?: number }) => void
    } = {}
    const serializeTerminalBuffer = vi
      .fn()
      .mockResolvedValueOnce({ data: 'initial snapshot', cols: 120, rows: 40 })
      .mockImplementation(recover)
    const harness = startDesktopMultiplexSubscribe({
      serializeTerminalBuffer,
      subscribeToTerminalData: vi.fn(
        (
          _: string,
          listener: (data: string, meta?: { seq?: number; rawLength?: number }) => void
        ) => {
          dataListenerRef.current = listener
          return vi.fn()
        }
      )
    })

    await vi.waitFor(() =>
      expect(harness.messages.some((message) => JSON.parse(message).result?.type === 'ready')).toBe(
        true
      )
    )
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() =>
      expect(
        harness.messages.some((message) => JSON.parse(message).result?.type === 'subscribed')
      ).toBe(true)
    )
    harness.binaryFrames.splice(0)

    const output = 'x'.repeat(3 * 1024 * 1024)
    dataListenerRef.current?.(output, { seq: output.length, rawLength: output.length })
    const inFlightBytes = harness.binaryFrames
      .map((bytes) => decodeTerminalStreamFrame(bytes))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
      .reduce((total, frame) => total + (frame?.payload.byteLength ?? 0), 0)
    harness.handlers.get(7)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Ack,
          streamId: 7,
          seq: 2,
          payload: encodeTerminalStreamJson({ bytes: inFlightBytes })
        })
      )!
    )

    await vi.waitFor(() => {
      const eventTypes = harness.messages.map((message) => JSON.parse(message).result?.type)
      expect(eventTypes).toContain('error')
      expect(eventTypes).toContain('end')
    })
    expect(harness.handlers.has(7)).toBe(false)
    expect(serializeTerminalBuffer).toHaveBeenCalledTimes(2)
    await Promise.resolve()
    await Promise.resolve()
    expect(serializeTerminalBuffer).toHaveBeenCalledTimes(2)

    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
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
        // Recovery seq covers the flood, so all retained chunks already appear in the snapshot.
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
    // Covered chunks would duplicate recovered snapshot content.
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
})
