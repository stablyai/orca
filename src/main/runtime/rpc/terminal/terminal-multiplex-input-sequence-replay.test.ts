import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'

import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { TERMINAL_METHODS } from '../methods/terminal/terminal'
import { createSubscriptionRegistryDouble } from '../testing/subscription-registry-test-double'
import type { RuntimeTerminalWait } from '../../../../shared/runtime-terminal-contracts'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText,
  decodeTerminalInputAck,
  type TerminalInputAckKind
} from '../../../../shared/terminal/stream/terminal-stream-protocol'
import { makeRequest, stubRuntime } from './testing/terminal-multiplex-test-harness'

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: facade.listWorktreesStrict
  }
})

const { getWorktreeListingMocks } = vi.hoisted(() => {
  const createWorktreeListingMocks = () => ({
    listWorktreesStrict: async () => [
      { path: '/tmp/worktree-a', head: 'abc', branch: 'test', isBare: false, isMainWorktree: false }
    ]
  })
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

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
})
