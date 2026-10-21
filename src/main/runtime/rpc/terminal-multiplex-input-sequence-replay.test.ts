import './unused-default-rpc-methods.test-fixture'
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
  encodeTerminalStreamText,
  decodeTerminalInputAck,
  type TerminalInputAckKind
} from '../../../shared/terminal-stream-protocol'
import { makeRequest, stubRuntime } from './terminal-multiplex-test-harness'

type FrameHandler = (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void

type ScriptedWrite = 'accept' | 'reject' | 'throw' | 'unverifiable' | 'unhanded'

function createRuntime(
  writes: string[],
  writeGate: () => Promise<void> = async () => {},
  scriptedWrites: ScriptedWrite[] = [],
  sendOptions: unknown[] = []
): OrcaRuntimeService {
  const registry = createSubscriptionRegistryDouble()
  return stubRuntime({
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi.fn().mockResolvedValue({ data: 'snapshot', cols: 120, rows: 40 }),
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
    cleanupSubscriptionIfOwnedByConnection: vi.fn(registry.cleanupSubscriptionIfOwnedByConnection),
    cleanupSubscriptionsForConnection: vi.fn(registry.cleanupSubscriptionsForConnection),
    waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
    updateDesktopViewport: vi.fn().mockResolvedValue(true),
    sendTerminal: vi.fn(async (_handle: string, action: { text?: string }, options: unknown) => {
      sendOptions.push(options)
      await writeGate()
      const scripted = scriptedWrites.shift() ?? 'accept'
      if (scripted === 'unverifiable') {
        // The SSH provider queued the bytes, then its connection dropped before the handoff settled.
        return {
          handle: 'terminal-1',
          accepted: false,
          bytesWritten: 0,
          writeSettlement: {
            outcome: 'unverifiable' as const,
            reason: 'transport_settlement_lost' as const,
            bytesHandedToTransport: true
          }
        }
      }
      if (scripted === 'unhanded') {
        // Settlement lost, but the provider proves no byte left before it was disposed.
        return {
          handle: 'terminal-1',
          accepted: false,
          bytesWritten: 0,
          writeSettlement: {
            outcome: 'unverifiable' as const,
            reason: 'transport_settlement_lost' as const,
            bytesHandedToTransport: false
          }
        }
      }
      if (scripted === 'throw') {
        throw new Error('ssh channel write failed')
      }
      if (scripted === 'reject') {
        return { handle: 'terminal-1', accepted: false, bytesWritten: 0 }
      }
      writes.push(action.text ?? '')
      return { handle: 'terminal-1', accepted: true, bytesWritten: action.text?.length ?? 0 }
    })
  })
}

async function openConnection(
  dispatcher: RpcDispatcher,
  connectionId: string,
  subscribe: { capabilities: Record<string, 1>; inputSessionId?: string }
) {
  const messages: string[] = []
  const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
  const handlers = new Map<number, FrameHandler>()
  void dispatcher.dispatchStreaming(
    makeRequest('terminal.multiplex', {}),
    (message) => messages.push(message),
    {
      connectionId,
      sendBinary: (bytes) => {
        binaryFrames.push(bytes)
      },
      registerBinaryStreamHandler: (streamId, handler) => {
        handlers.set(streamId, handler)
        return () => handlers.delete(streamId)
      }
    }
  )
  await vi.waitFor(() => expect(handlers.has(0)).toBe(true))
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
          viewport: { cols: 120, rows: 40 },
          ...subscribe
        })
      })
    )!
  )
  await vi.waitFor(() =>
    expect(messages.some((message) => JSON.parse(message).result?.type === 'subscribed')).toBe(true)
  )
  const subscribed: {
    capabilities?: Record<string, unknown>
    inputLedgerId?: string
  } = JSON.parse(
    messages.find((message) => JSON.parse(message).result?.type === 'subscribed')!
  ).result
  return {
    subscribed,
    sendInput: (seq: number, text: string) =>
      handlers.get(7)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Input,
            streamId: 7,
            seq,
            payload: encodeTerminalStreamText(text)
          })
        )!
      ),
    inputAcks: (kind: TerminalInputAckKind = 'applied') =>
      binaryFrames.flatMap((bytes) => {
        const frame = decodeTerminalStreamFrame(bytes)
        return frame?.opcode === TerminalStreamOpcode.InputAck &&
          decodeTerminalInputAck(frame.payload) === kind
          ? [frame.seq]
          : []
      }),
    writeUnavailableCount: () =>
      binaryFrames.filter(
        (bytes) =>
          decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.WriteUnavailable
      ).length
  }
}

describe('terminal multiplex sequenced input across reconnects', () => {
  it('writes input replayed on a new connection exactly once, even when the dead connection delivers late', async () => {
    const writes: string[] = []
    const dispatcher = new RpcDispatcher({
      runtime: createRuntime(writes),
      methods: TERMINAL_METHODS
    })
    const subscribe = {
      capabilities: { ackOutput: 1 as const, inputAck: 1 as const },
      inputSessionId: 'pane-a'
    }
    const dead = await openConnection(dispatcher, 'conn-dead', subscribe)
    expect(dead.subscribed.capabilities).toMatchObject({ inputAck: 1 })

    dead.sendInput(1, 'PZ600-0')
    await vi.waitFor(() => expect(dead.inputAcks()).toEqual([1]))
    // The ack for seq 2 never reaches the client: the link went silent.
    dead.sendInput(2, '12')

    const replacement = await openConnection(dispatcher, 'conn-replacement', subscribe)
    replacement.sendInput(2, '12')
    replacement.sendInput(3, '3\r')
    // The surviving SSH channel finally flushes the dead connection's buffered copy.
    dead.sendInput(3, '3\r')

    await vi.waitFor(() => expect(replacement.inputAcks()).toEqual([2, 3]))
    expect(writes).toEqual(['PZ600-0', '12', '3\r'])
  })

  it('never acks a write the PTY refused, and asks the same stream to resend instead of remounting', async () => {
    const writes: string[] = []
    const dispatcher = new RpcDispatcher({
      runtime: createRuntime(writes, async () => {}, ['accept', 'reject']),
      methods: TERMINAL_METHODS
    })
    const subscribe = {
      capabilities: { writeUnavailable: 1 as const, inputAck: 1 as const },
      inputSessionId: 'pane-a'
    }
    const stream = await openConnection(dispatcher, 'conn-first', subscribe)
    stream.sendInput(1, 'echo a\r')
    stream.sendInput(2, 'echo b\r')
    stream.sendInput(3, 'echo c\r')
    await vi.waitFor(() => expect(stream.inputAcks('resend')).toEqual([1, 1]))
    // Neither the refused seq 2 nor seq 3 behind it may be acked, or the client drops them.
    expect(stream.inputAcks()).toEqual([1])
    expect(writes).toEqual(['echo a\r'])
    // A remount would throw away the client's journal, so a sequenced refusal must not ask for one.
    expect(stream.writeUnavailableCount()).toBe(0)

    // The PTY is writable again: the live stream resends, and typing after it keeps flowing.
    stream.sendInput(2, 'echo b\r')
    stream.sendInput(3, 'echo c\r')
    stream.sendInput(4, 'echo d\r')
    await vi.waitFor(() => expect(stream.inputAcks()).toEqual([1, 2, 3, 4]))
    expect(writes).toEqual(['echo a\r', 'echo b\r', 'echo c\r', 'echo d\r'])
  })

  it('acks sequenced input only once the provider settles its handoff', async () => {
    const writes: string[] = []
    const sendOptions: unknown[] = []
    const dispatcher = new RpcDispatcher({
      runtime: createRuntime(writes, async () => {}, ['unverifiable'], sendOptions),
      methods: TERMINAL_METHODS
    })
    const subscribe = { capabilities: { inputAck: 1 as const }, inputSessionId: 'pane-a' }
    const connection = await openConnection(dispatcher, 'conn-1', subscribe)
    connection.sendInput(1, 'make deploy\r')
    await vi.waitFor(() => expect(connection.inputAcks('delivery-unknown')).toEqual([1]))
    expect(sendOptions[0]).toMatchObject({ requireWriteSettlement: true })
    // Unknown, not refused: a resend could run the command twice.
    expect(connection.inputAcks('resend')).toEqual([])
  })

  it('asks for a resend when an unsettled handoff proves no byte left', async () => {
    const writes: string[] = []
    const dispatcher = new RpcDispatcher({
      runtime: createRuntime(writes, async () => {}, ['unhanded']),
      methods: TERMINAL_METHODS
    })
    const subscribe = {
      capabilities: { inputAck: 1 as const },
      inputSessionId: 'pane-a'
    }
    const connection = await openConnection(dispatcher, 'conn-1', subscribe)
    connection.sendInput(1, 'make deploy\r')
    await vi.waitFor(() => expect(connection.inputAcks('resend')).toEqual([0]))
    connection.sendInput(1, 'make deploy\r')
    await vi.waitFor(() => expect(connection.inputAcks()).toEqual([1]))
    expect(writes).toEqual(['make deploy\r'])
  })

  it('tells the client a thrown write has unknown delivery instead of acking it as applied', async () => {
    const writes: string[] = []
    const dispatcher = new RpcDispatcher({
      runtime: createRuntime(writes, async () => {}, ['throw']),
      methods: TERMINAL_METHODS
    })
    const subscribe = { capabilities: { inputAck: 1 as const }, inputSessionId: 'pane-a' }
    const connection = await openConnection(dispatcher, 'conn-1', subscribe)
    connection.sendInput(1, 'make deploy\r')
    connection.sendInput(2, 'ls\r')
    await vi.waitFor(() => expect(connection.inputAcks()).toEqual([2]))
    expect(connection.inputAcks('delivery-unknown')).toEqual([1])
    expect(writes).toEqual(['ls\r'])
  })

  it('names its input ledger so a restarted runtime is never mistaken for the one that applied input', async () => {
    const subscribe = { capabilities: { inputAck: 1 as const }, inputSessionId: 'pane-a' }
    const before = await openConnection(
      new RpcDispatcher({ runtime: createRuntime([]), methods: TERMINAL_METHODS }),
      'conn-before',
      subscribe
    )
    // The PTY survives in the daemon; only the runtime (and its in-memory ledger) is new.
    const after = await openConnection(
      new RpcDispatcher({ runtime: createRuntime([]), methods: TERMINAL_METHODS }),
      'conn-after',
      subscribe
    )
    expect(before.subscribed.inputLedgerId).toEqual(expect.any(String))
    expect(after.subscribed.inputLedgerId).toEqual(expect.any(String))
    expect(after.subscribed.inputLedgerId).not.toBe(before.subscribed.inputLedgerId)
  })

  it('acks a replayed duplicate only after the original write lands', async () => {
    const writes: string[] = []
    let releaseWrite = (): void => {}
    let gated = true
    const dispatcher = new RpcDispatcher({
      runtime: createRuntime(writes, () =>
        gated
          ? new Promise<void>((resolve) => {
              releaseWrite = resolve
            })
          : Promise.resolve()
      ),
      methods: TERMINAL_METHODS
    })
    const subscribe = { capabilities: { inputAck: 1 as const }, inputSessionId: 'pane-a' }
    const dead = await openConnection(dispatcher, 'conn-dead', subscribe)
    dead.sendInput(1, 'make deploy\r')
    const replacement = await openConnection(dispatcher, 'conn-replacement', subscribe)
    replacement.sendInput(1, 'make deploy\r')

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(writes).toEqual([])
    expect(replacement.inputAcks()).toEqual([])
    gated = false
    releaseWrite()
    await vi.waitFor(() => expect(replacement.inputAcks()).toEqual([1]))
    expect(writes).toEqual(['make deploy\r'])
  })

  it('keeps input from separate panes independent', async () => {
    const writes: string[] = []
    const dispatcher = new RpcDispatcher({
      runtime: createRuntime(writes),
      methods: TERMINAL_METHODS
    })
    const left = await openConnection(dispatcher, 'conn-left', {
      capabilities: { inputAck: 1 },
      inputSessionId: 'pane-left'
    })
    const right = await openConnection(dispatcher, 'conn-right', {
      capabilities: { inputAck: 1 },
      inputSessionId: 'pane-right'
    })

    left.sendInput(1, 'l')
    right.sendInput(1, 'r')

    await vi.waitFor(() => expect(writes).toEqual(['l', 'r']))
  })

  it('leaves a client that did not negotiate input acks on the unsequenced path', async () => {
    const writes: string[] = []
    const dispatcher = new RpcDispatcher({
      runtime: createRuntime(writes),
      methods: TERMINAL_METHODS
    })
    // An older client never names an input session; a session id without the capability is ignored too.
    const legacy = await openConnection(dispatcher, 'conn-legacy', {
      capabilities: { ackOutput: 1 },
      inputSessionId: 'pane-legacy'
    })
    expect(legacy.subscribed.capabilities?.inputAck).toBeUndefined()

    legacy.sendInput(2, 'x')
    legacy.sendInput(2, 'x')

    await vi.waitFor(() => expect(writes).toEqual(['x', 'x']))
    expect(legacy.inputAcks()).toEqual([])
  })
})
