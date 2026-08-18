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
import {
  type OverflowRecoverySnapshot,
  acknowledgeSourceRangeOverflow,
  sendDesktopSourceRangeSubscribe,
  sourceRange,
  startSourceRangeOverflowHarness
} from './terminal-multiplex-source-range-fixtures'

describe('terminal multiplex RPC', () => {
  it('replaces UTF-8-expanded overflow ranges before publishing the trailing live range', async () => {
    let resolveRecovery: (snapshot: OverflowRecoverySnapshot) => void = () => {}
    const harness = startSourceRangeOverflowHarness({
      recover: () =>
        new Promise<OverflowRecoverySnapshot>((resolve) => {
          resolveRecovery = resolve
        })
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendDesktopSourceRangeSubscribe(harness.handlers)
    await vi.waitFor(() => expect(harness.getDataListener()).toBeDefined())

    const flooded = '界'.repeat(1024 * 1024)
    const credit = await acknowledgeSourceRangeOverflow(
      harness,
      harness.getDataListener()!,
      flooded,
      'first'
    )
    await vi.waitFor(() => expect(harness.runtime.serializeTerminalBuffer).toHaveBeenCalledTimes(2))
    const trailing = 'trailing-live'
    harness.getDataListener()!(trailing, {
      seq: flooded.length + trailing.length,
      rawLength: trailing.length,
      sourceRanges: [sourceRange(flooded.length, flooded.length + trailing.length)]
    })
    resolveRecovery({
      data: 'authoritative snapshot',
      cols: 120,
      rows: 40,
      source: 'headless',
      seq: flooded.length
    })

    await vi.waitFor(() => expect(harness.commit).toHaveBeenCalledOnce())
    expect(harness.reserve).toHaveBeenLastCalledWith(
      expect.objectContaining({ streamGeneration: expect.any(String) }),
      flooded.length,
      'ack-pending-overflow'
    )
    expect(harness.lifecycle).toEqual(['reserve', 'commit'])
    const recoveryFrames = harness.binaryFrames.map(decodeTerminalStreamFrame)
    const snapshotEnd = recoveryFrames.findLastIndex(
      (frame) => frame?.opcode === TerminalStreamOpcode.SnapshotEnd
    )
    const trailingOutput = recoveryFrames.findIndex(
      (frame, index) =>
        index > snapshotEnd &&
        frame?.opcode === TerminalStreamOpcode.Output &&
        decodeTerminalStreamText(frame.payload) === trailing
    )
    expect(snapshotEnd).toBeGreaterThanOrEqual(0)
    expect(trailingOutput).toBeGreaterThan(snapshotEnd)
    expect(harness.rollback).not.toHaveBeenCalled()
    const trailingBytes = recoveryFrames[trailingOutput]!.payload.byteLength
    harness.handlers.get(7)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Ack,
          streamId: 7,
          seq: 3,
          payload: encodeTerminalStreamJson({
            streamGeneration: credit.streamGeneration,
            ackedEndByte: credit.acceptedEndByte + trailingBytes
          })
        })
      )!
    )
    expect(harness.runtime.settleRemoteTerminalSourceRanges).toHaveBeenLastCalledWith(
      expect.any(Object),
      [sourceRange(flooded.length, flooded.length + trailing.length)]
    )

    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })

  it('rolls back overflow replacement before detaching on partial frame publication', async () => {
    let recoveryStarted = false
    const harness = startSourceRangeOverflowHarness({
      recover: async () => ({
        data: 'authoritative snapshot',
        cols: 120,
        rows: 40,
        source: 'headless',
        seq: 3 * 1024 * 1024
      }),
      onFrame: (frame) => {
        if (frame.opcode === TerminalStreamOpcode.SnapshotStart) {
          recoveryStarted =
            decodeTerminalStreamJson<{ reason?: string }>(frame.payload)?.reason ===
            'ack-pending-overflow'
        }
        if (recoveryStarted && frame.opcode === TerminalStreamOpcode.SnapshotChunk) {
          return false
        }
        return undefined
      }
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendDesktopSourceRangeSubscribe(harness.handlers)
    await vi.waitFor(() => expect(harness.getDataListener()).toBeDefined())

    const flooded = 'x'.repeat(3 * 1024 * 1024)
    await acknowledgeSourceRangeOverflow(harness, harness.getDataListener()!, flooded)
    await harness.dispatchPromise

    expect(harness.commit).not.toHaveBeenCalled()
    expect(harness.rollback).toHaveBeenCalledOnce()
    expect(harness.lifecycle).toEqual(['reserve', 'rollback', 'cancel'])
  })

  it('rolls back overflow replacement before generic detach when commit rejects', async () => {
    const flooded = 'x'.repeat(3 * 1024 * 1024)
    const harness = startSourceRangeOverflowHarness({
      recover: async () => ({
        data: 'authoritative snapshot',
        cols: 120,
        rows: 40,
        source: 'renderer',
        seq: flooded.length
      }),
      commit: () => false
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendDesktopSourceRangeSubscribe(harness.handlers)
    await vi.waitFor(() => expect(harness.getDataListener()).toBeDefined())

    await acknowledgeSourceRangeOverflow(harness, harness.getDataListener()!, flooded)
    await vi.waitFor(() => expect(harness.cancel).toHaveBeenCalledOnce())

    expect(harness.commit).toHaveBeenCalledOnce()
    expect(harness.rollback).toHaveBeenCalledOnce()
    expect(harness.lifecycle).toEqual(['reserve', 'commit', 'rollback', 'cancel'])
    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })

  it('rolls back a held overflow replacement when its stream detaches', async () => {
    const flooded = 'x'.repeat(3 * 1024 * 1024)
    let harness: ReturnType<typeof startSourceRangeOverflowHarness>
    harness = startSourceRangeOverflowHarness({
      recover: async () => ({
        data: 'authoritative snapshot',
        cols: 120,
        rows: 40,
        source: 'headless',
        seq: flooded.length
      }),
      onFrame: (frame) => {
        if (
          frame.opcode !== TerminalStreamOpcode.SnapshotStart ||
          decodeTerminalStreamJson<{ reason?: string }>(frame.payload)?.reason !==
            'ack-pending-overflow'
        ) {
          return
        }
        harness.handlers.get(7)?.(
          decodeTerminalStreamFrame(
            encodeTerminalStreamFrame({
              opcode: TerminalStreamOpcode.Unsubscribe,
              streamId: 7,
              seq: 3,
              payload: new Uint8Array()
            })
          )!
        )
      }
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendDesktopSourceRangeSubscribe(harness.handlers)
    await vi.waitFor(() => expect(harness.getDataListener()).toBeDefined())

    await acknowledgeSourceRangeOverflow(harness, harness.getDataListener()!, flooded)
    await vi.waitFor(() => expect(harness.handlers.has(7)).toBe(false))

    expect(harness.commit).not.toHaveBeenCalled()
    expect(harness.rollback).toHaveBeenCalledOnce()
    expect(harness.lifecycle).toEqual(['reserve', 'rollback', 'cancel'])
    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })

  it('rolls back overflow replacement before a same-slot generation succeeds it', async () => {
    const flooded = 'x'.repeat(3 * 1024 * 1024)
    let harness: ReturnType<typeof startSourceRangeOverflowHarness>
    harness = startSourceRangeOverflowHarness({
      recover: async () => ({
        data: 'authoritative snapshot',
        cols: 120,
        rows: 40,
        source: 'headless',
        seq: flooded.length
      }),
      onFrame: (frame) => {
        if (
          frame.opcode !== TerminalStreamOpcode.SnapshotStart ||
          decodeTerminalStreamJson<{ reason?: string }>(frame.payload)?.reason !==
            'ack-pending-overflow'
        ) {
          return
        }
        harness.handlers.get(0)?.(
          decodeTerminalStreamFrame(
            encodeTerminalStreamFrame({
              opcode: TerminalStreamOpcode.Subscribe,
              streamId: 0,
              seq: 3,
              payload: encodeTerminalStreamJson({
                streamId: 7,
                terminal: 'terminal-1',
                client: { id: 'desktop-2', type: 'desktop' },
                capabilities: { ackOutput: 1, ackOutputSourceRanges: 1 }
              })
            })
          )!
        )
      }
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendDesktopSourceRangeSubscribe(harness.handlers)
    await vi.waitFor(() => expect(harness.getDataListener()).toBeDefined())

    await acknowledgeSourceRangeOverflow(harness, harness.getDataListener()!, flooded)
    await vi.waitFor(() =>
      expect(
        harness.messages.filter((message) => JSON.parse(message).result?.type === 'subscribed')
          .length
      ).toBe(2)
    )

    expect(harness.commit).not.toHaveBeenCalled()
    expect(harness.rollback).toHaveBeenCalledOnce()
    expect(harness.lifecycle.slice(0, 3)).toEqual(['reserve', 'rollback', 'cancel'])
    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })

  it('does not publish or trim overflow output without serialized source identity', async () => {
    const flooded = 'x'.repeat(3 * 1024 * 1024)
    const harness = startSourceRangeOverflowHarness({
      recover: async () => ({
        data: 'unattributed snapshot',
        cols: 120,
        rows: 40,
        seq: flooded.length
      })
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendDesktopSourceRangeSubscribe(harness.handlers)
    await vi.waitFor(() => expect(harness.getDataListener()).toBeDefined())
    const frameCount = harness.binaryFrames.length

    await acknowledgeSourceRangeOverflow(harness, harness.getDataListener()!, flooded)
    await vi.waitFor(() => expect(harness.cancel).toHaveBeenCalledOnce())

    expect(harness.reserve.mock.calls.some((call) => call[2] === 'ack-pending-overflow')).toBe(
      false
    )
    expect(harness.commit).not.toHaveBeenCalled()
    expect(harness.rollback).not.toHaveBeenCalled()
    expect(
      harness.binaryFrames
        .slice(frameCount)
        .map(decodeTerminalStreamFrame)
        .some(
          (frame) =>
            frame?.opcode === TerminalStreamOpcode.SnapshotStart &&
            decodeTerminalStreamJson<{ reason?: string }>(frame.payload)?.reason ===
              'ack-pending-overflow'
        )
    ).toBe(false)
    harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
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
})
