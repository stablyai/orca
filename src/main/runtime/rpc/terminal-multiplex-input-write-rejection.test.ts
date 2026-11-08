import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'
import type { RuntimeTerminalWait } from '../../../shared/runtime-terminal-contracts'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamText
} from '../../../shared/terminal/stream/terminal-stream-protocol'
import {
  WRITE_UNAVAILABLE_OPCODE,
  makeRequest,
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe,
  stubRuntime
} from './terminal-multiplex-test-harness'

describe('terminal multiplex rejected input signalling', () => {
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
  it('never sends the rejection opcode to an un-negotiated legacy binary stream', async () => {
    // Legacy mobile knows opcodes only through 12 and must not receive 17. Drive capable desktop second to prove rejection was already processed for both.
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
