import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import { makeRequest, stubRuntime } from './terminal-multiplex-test-harness'

describe('terminal multiplex RPC', () => {
  it('flushes multibyte live output when encoded bytes reach the batch budget', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
      const handlers = new Map<
        number,
        (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
      >()
      const registry = createSubscriptionRegistryDouble()
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
        registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
        registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
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

      registry.cleanupSubscription('terminal-multiplex:conn-multibyte-output-batch')
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
    const registry = createSubscriptionRegistryDouble()
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
      registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
      registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
      cleanupSubscription: vi.fn(registry.cleanupSubscription),
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

  it('round-robins released ACK budget to a later interactive stream', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const registry = createSubscriptionRegistryDouble()
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
      registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
      registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
      cleanupSubscription: vi.fn(registry.cleanupSubscription),
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

    const streamIds = [21, 22, 23, 24, 25, 26, 27, 28]
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

    const fillerOutput = 'f'.repeat(512 * 1024)
    for (let index = 1; index <= 4; index += 1) {
      dataListeners.get(`pty-${index}`)?.(fillerOutput, {
        seq: fillerOutput.length,
        rawLength: fillerOutput.length
      })
    }
    const queuedFillerOutput = 'q'.repeat(256 * 1024)
    for (let index = 1; index <= 4; index += 1) {
      dataListeners.get(`pty-${index}`)?.(queuedFillerOutput, {
        seq: fillerOutput.length + queuedFillerOutput.length,
        rawLength: queuedFillerOutput.length
      })
    }
    const stalledOutput = 's'.repeat(256 * 1024)
    for (let index = 5; index <= 7; index += 1) {
      dataListeners.get(`pty-${index}`)?.(stalledOutput, {
        seq: stalledOutput.length,
        rawLength: stalledOutput.length
      })
    }
    const interactiveOutput = 'interactive-output\r\n'
    dataListeners.get('pty-8')?.(interactiveOutput, {
      seq: interactiveOutput.length,
      rawLength: interactiveOutput.length
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

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
    expect(initialBytesByStream.get(21)).toBe(512 * 1024)
    expect(initialBytesByStream.get(22)).toBe(512 * 1024)
    expect(initialBytesByStream.get(23)).toBe(512 * 1024)
    expect(initialBytesByStream.get(24)).toBe(512 * 1024)
    expect(initialBytesByStream.get(25) ?? 0).toBe(0)
    expect(initialBytesByStream.get(26) ?? 0).toBe(0)
    expect(initialBytesByStream.get(27) ?? 0).toBe(0)
    expect(initialBytesByStream.get(28) ?? 0).toBe(0)

    handlers.get(28)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          streamId: 28,
          seq: 200,
          payload: encodeTerminalStreamText('remote-still-interactive\r')
        })
      )!
    )
    await vi.waitFor(() =>
      expect(runtime.sendTerminal).toHaveBeenCalledWith('terminal-8', {
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
          .some(
            (frame) =>
              frame?.streamId === 28 &&
              frame.opcode === TerminalStreamOpcode.Output &&
              decodeTerminalStreamText(frame.payload) === interactiveOutput
          )
      ).toBe(true)
    )
    const framesAfterAck = binaryFrames
      .slice(frameCountBeforeAck)
      .map((frame) => decodeTerminalStreamFrame(frame))
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
    expect(bytesAfterAckByStream.get(25) ?? 0).toBeGreaterThan(0)
    expect(bytesAfterAckByStream.get(26) ?? 0).toBeGreaterThan(0)
    expect(bytesAfterAckByStream.get(27) ?? 0).toBeGreaterThan(0)
    expect(bytesAfterAckByStream.get(28) ?? 0).toBe(interactiveOutput.length)
    expect(bytesAfterAckByStream.get(21) ?? 0).toBeGreaterThan(0)
    expect(
      outputFramesAfterAck.reduce((total, frame) => total + (frame?.payload.byteLength ?? 0), 0)
    ).toBeLessThanOrEqual((initialBytesByStream.get(21) ?? 0) * 2)

    runtime.cleanupSubscription('terminal-multiplex:conn-ack-shared-budget')
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
      const registry = createSubscriptionRegistryDouble()
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
})
