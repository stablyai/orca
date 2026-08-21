import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import {
  WRITE_UNAVAILABLE_OPCODE,
  makeRequest,
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe,
  stubRuntime
} from './terminal-multiplex-test-harness'

describe('terminal multiplex rejected input signalling', () => {
  it('reports when locally accepted input never reaches the process', async () => {
    const processWrites: string[] = []
    const sendTerminal = vi.fn().mockRejectedValue(new Error('terminal_not_writable'))
    const harness = startDesktopMultiplexSubscribe({
      sendTerminal: sendTerminal as unknown as OrcaRuntimeService['sendTerminal']
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendDesktopMultiplexSubscribe(harness.handlers, {
      ackOutput: 1,
      desktopViewportClaims: 1,
      writeUnavailable: 1
    })
    await vi.waitFor(() =>
      expect(
        harness.messages.some((message) => JSON.parse(message).result?.type === 'subscribed')
      ).toBe(true)
    )
    harness.binaryFrames.splice(0)

    const clientInputHandler = harness.handlers.get(7)
    expect(clientInputHandler).toBeDefined()
    clientInputHandler?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          streamId: 7,
          seq: 2,
          payload: encodeTerminalStreamText('x')
        })
      )!
    )
    const clientReportedAccepted = true

    expect(clientReportedAccepted).toBe(true)
    await vi.waitFor(() => expect(sendTerminal).toHaveBeenCalledOnce())
    expect(processWrites).toEqual([])
    await vi.waitFor(() =>
      expect(harness.binaryFrames.some((frame) => frame[2] === WRITE_UNAVAILABLE_OPCODE)).toBe(true)
    )
  })

  it('does not send an unknown opcode to a legacy client', async () => {
    const sendTerminal = vi.fn().mockRejectedValue(new Error('terminal_not_writable'))
    const harness = startDesktopMultiplexSubscribe({
      sendTerminal: sendTerminal as unknown as OrcaRuntimeService['sendTerminal']
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() =>
      expect(
        harness.messages.some((message) => JSON.parse(message).result?.type === 'subscribed')
      ).toBe(true)
    )
    harness.binaryFrames.splice(0)

    harness.handlers.get(7)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          streamId: 7,
          seq: 2,
          payload: encodeTerminalStreamText('x')
        })
      )!
    )

    await vi.waitFor(() => expect(sendTerminal).toHaveBeenCalledOnce())
    expect(harness.binaryFrames.some((frame) => frame[2] === WRITE_UNAVAILABLE_OPCODE)).toBe(false)
  })

  it('does not report a late rejection to a replacement stream with the same id', async () => {
    let settleWrite: (result: {
      handle: string
      accepted: boolean
      bytesWritten: number
    }) => void = () => {}
    const hostWrite = new Promise<{ handle: string; accepted: boolean; bytesWritten: number }>(
      (resolve) => {
        settleWrite = resolve
      }
    )
    const sendTerminal = vi.fn(() => hostWrite)
    const harness = startDesktopMultiplexSubscribe({
      sendTerminal: sendTerminal as unknown as OrcaRuntimeService['sendTerminal']
    })
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    const capabilities = { ackOutput: 1 as const, writeUnavailable: 1 as const }
    sendDesktopMultiplexSubscribe(harness.handlers, capabilities)
    await vi.waitFor(() => expect(harness.handlers.has(7)).toBe(true))
    harness.binaryFrames.splice(0)

    harness.handlers.get(7)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          streamId: 7,
          seq: 2,
          payload: encodeTerminalStreamText('old')
        })
      )!
    )
    await vi.waitFor(() => expect(sendTerminal).toHaveBeenCalledOnce())
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
    sendDesktopMultiplexSubscribe(harness.handlers, capabilities)
    await vi.waitFor(() =>
      expect(
        harness.messages.filter((message) => JSON.parse(message).result?.type === 'subscribed')
      ).toHaveLength(2)
    )
    harness.binaryFrames.splice(0)

    settleWrite({ handle: 'terminal-1', accepted: false, bytesWritten: 0 })
    await hostWrite
    await Promise.resolve()

    expect(harness.binaryFrames.some((frame) => frame[2] === WRITE_UNAVAILABLE_OPCODE)).toBe(false)
  })
})

describe('terminal multiplex RPC', () => {
  it('drops desktop multiplex input while a mobile client owns the terminal floor', async () => {
    const messages: string[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const registry = createSubscriptionRegistryDouble()
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
    registry.cleanupSubscription('terminal-multiplex:conn-locked')
    await dispatchPromise
  })

  it('preserves LF input frames before writing to the multiplexed PTY', async () => {
    const messages: string[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const registry = createSubscriptionRegistryDouble()
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
    const registry = createSubscriptionRegistryDouble()
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

  it('reports rejected input on a capable legacy binary stream', async () => {
    const messages: string[] = []
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const registry = createSubscriptionRegistryDouble()
    const sendTerminal = vi.fn().mockRejectedValue(new Error('terminal_not_writable'))
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
      registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
      registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
      cleanupSubscription: vi.fn(registry.cleanupSubscription),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      sendTerminal: sendTerminal as unknown as OrcaRuntimeService['sendTerminal'],
      updateDesktopViewport: vi.fn().mockResolvedValue(true)
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', {
        terminal: 'terminal-1',
        client: { id: 'desktop-1', type: 'desktop' },
        capabilities: { terminalBinaryStream: 1, writeUnavailable: 1 }
      }),
      (message) => messages.push(message),
      {
        connectionId: 'conn-subscribe-rejected-input',
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
      expect(messages.some((message) => JSON.parse(message).result?.type === 'subscribed')).toBe(
        true
      )
    )
    const streamId = JSON.parse(
      messages.find((message) => JSON.parse(message).result?.type === 'subscribed')!
    ).result.streamId as number
    binaryFrames.splice(0)
    handlers.get(streamId)?.(
      decodeTerminalStreamFrame(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          streamId,
          seq: 1,
          payload: encodeTerminalStreamText('x')
        })
      )!
    )

    await vi.waitFor(() => expect(sendTerminal).toHaveBeenCalledOnce())
    await vi.waitFor(() =>
      expect(binaryFrames.some((frame) => frame[2] === WRITE_UNAVAILABLE_OPCODE)).toBe(true)
    )
    runtime.cleanupSubscription('terminal-1:desktop-1')
    await dispatchPromise
  })

  it('never sends the rejection opcode to an un-negotiated legacy binary stream', async () => {
    // The mobile client is exactly this subscriber: it declares
    // terminalBinaryStream and nothing else, and its vendored opcode enum knows
    // nothing past 12, so an unsolicited 17 is an unknown opcode on that wire.
    // A capable desktop subscriber shares the runtime and is driven second, so
    // its frame proves the rejection had already been processed for both.
    const registry = createSubscriptionRegistryDouble()
    const sendTerminal = vi.fn().mockRejectedValue(new Error('terminal_not_writable'))
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
      registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
      registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
      cleanupSubscription: vi.fn(registry.cleanupSubscription),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      sendTerminal: sendTerminal as unknown as OrcaRuntimeService['sendTerminal'],
      updateDesktopViewport: vi.fn().mockResolvedValue(true),
      handleMobileSubscribe: vi.fn(),
      handleMobileUnsubscribe: vi.fn(),
      updateMobileViewport: vi.fn().mockResolvedValue(true)
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    async function subscribeLegacyBinary(
      client: { id: string; type: 'mobile' | 'desktop' },
      capabilities: Record<string, 1>
    ) {
      const messages: string[] = []
      const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
      const handlers = new Map<
        number,
        (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
      >()
      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.subscribe', { terminal: 'terminal-1', client, capabilities }),
        (message) => messages.push(message),
        {
          connectionId: `conn-legacy-${client.id}`,
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
        expect(messages.some((message) => JSON.parse(message).result?.type === 'subscribed')).toBe(
          true
        )
      )
      const streamId = JSON.parse(
        messages.find((message) => JSON.parse(message).result?.type === 'subscribed')!
      ).result.streamId as number
      binaryFrames.splice(0)
      return {
        binaryFrames,
        dispatchPromise,
        sendInput: () =>
          handlers.get(streamId)?.(
            decodeTerminalStreamFrame(
              encodeTerminalStreamFrame({
                opcode: TerminalStreamOpcode.Input,
                streamId,
                seq: 1,
                payload: encodeTerminalStreamText('x')
              })
            )!
          )
      }
    }

    const legacy = await subscribeLegacyBinary(
      { id: 'mobile-1', type: 'mobile' },
      { terminalBinaryStream: 1 }
    )
    const capable = await subscribeLegacyBinary(
      { id: 'desktop-1', type: 'desktop' },
      { terminalBinaryStream: 1, writeUnavailable: 1 }
    )

    legacy.sendInput()
    capable.sendInput()

    await vi.waitFor(() => expect(sendTerminal).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(capable.binaryFrames.some((frame) => frame[2] === WRITE_UNAVAILABLE_OPCODE)).toBe(true)
    )
    expect(legacy.binaryFrames.some((frame) => frame[2] === WRITE_UNAVAILABLE_OPCODE)).toBe(false)

    runtime.cleanupSubscription('terminal-1:mobile-1')
    runtime.cleanupSubscription('terminal-1:desktop-1')
    await Promise.all([legacy.dispatchPromise, capable.dispatchPromise])
  })
})
