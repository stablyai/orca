import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'
import type { RuntimeTerminalWait } from '../../../shared/runtime-terminal-contracts'
import { TerminalPublishedOutputRings } from '../terminal/output/terminal-published-output-ring'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText
} from '../../../shared/terminal/stream/terminal-stream-protocol'

const CHUNK = 64 * 1024

async function startCreditedSubscription() {
  const frames: Uint8Array<ArrayBufferLike>[] = []
  const messages: string[] = []
  const registry = createSubscriptionRegistryDouble()
  let dataListener: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null =
    null
  let outputSeq = 0
  let exitListener: (() => void) | null = null
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This partial runtime supplies the terminal RPC methods these tests invoke.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    subscribeToPtyExit: vi.fn((_ptyId: string, listener: () => void) => {
      exitListener = listener
      return vi.fn()
    }),
    registerRemoteTerminalViewSubscriber: () => () => {},
    requestRendererTerminalTabMount: () => false,
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    handleMobileSubscribe: vi.fn().mockResolvedValue(true),
    handleMobileUnsubscribe: vi.fn(),
    subscribeToTerminalData: vi.fn((_ptyId, listener) => {
      dataListener = listener
      return vi.fn()
    }),
    retainPublishedTerminalOutput: (ptyId: string) =>
      new TerminalPublishedOutputRings().retain(ptyId, {
        seq: 0,
        size: () => null,
        subscribe: () => () => {}
      }),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi.fn(async () => ({
      data: 'screen',
      cols: 80,
      rows: 24,
      seq: outputSeq
    })),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
    registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
    cleanupSubscription: vi.fn(registry.cleanupSubscription),
    waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const done = dispatcher.dispatchStreaming(
    {
      id: 'sub',
      authToken: 'tok',
      method: 'terminal.subscribe',
      params: {
        terminal: 'terminal-1',
        client: { id: 'phone-1', type: 'mobile' },
        capabilities: { terminalBinaryStream: 1, outputAck: 1 }
      }
    },
    (msg) => messages.push(msg),
    {
      connectionId: 'conn-phone',
      pairedDeviceId: 'phone-device',
      sendBinary: (bytes) => {
        frames.push(bytes)
      },
      registerBinaryStreamHandler: vi.fn(() => vi.fn())
    }
  )
  const subscribed = await vi.waitFor(() => {
    const result = messages
      .map((msg) => JSON.parse(msg).result)
      .find((candidate) => candidate?.type === 'subscribed')
    expect(result).toBeDefined()
    return result
  })
  await vi.waitFor(() => expect(dataListener).not.toBeNull())
  return {
    subscribed,
    output: (count: number, length = CHUNK) => {
      for (let index = 0; index < count; index += 1) {
        outputSeq += length
        dataListener!('x'.repeat(length), { seq: outputSeq, rawLength: length })
      }
    },
    sentOutputUnits: () =>
      frames.reduce((total, bytes) => {
        const frame = decodeTerminalStreamFrame(bytes)
        return frame?.opcode === TerminalStreamOpcode.Output
          ? total + decodeTerminalStreamText(frame.payload).length
          : total
      }, 0),
    snapshotKinds: () =>
      frames.flatMap((bytes) => {
        const frame = decodeTerminalStreamFrame(bytes)
        return frame?.opcode === TerminalStreamOpcode.SnapshotStart
          ? [decodeTerminalStreamJson<{ kind: string }>(frame.payload)?.kind]
          : []
      }),
    ack: async (streamToken: string, units: number, pairedDeviceId = 'phone-device') =>
      (
        await dispatcher.dispatch(
          {
            id: 'ack',
            authToken: 'tok',
            method: 'terminal.ackOutput',
            params: { streamToken, units }
          },
          { connectionId: 'conn-phone', pairedDeviceId }
        )
      ).ok,
    exit: async () => {
      exitListener!()
      await done
    },
    stop: async () => {
      runtime.cleanupSubscription('terminal-1:phone-1')
      await done
    }
  }
}

describe('terminal.subscribe output credit', () => {
  it('holds output beyond the window until the stream token is acked', async () => {
    const stream = await startCreditedSubscription()
    expect(stream.subscribed).toMatchObject({ outputAck: true, streamToken: expect.any(String) })

    stream.output(9)
    expect(stream.sentOutputUnits()).toBe(512 * 1024)

    await stream.ack(stream.subscribed.streamToken, CHUNK)
    expect(stream.sentOutputUnits()).toBe(576 * 1024)
    await stream.stop()
  })

  it("credits nothing for another device's ack or an unknown token", async () => {
    const stream = await startCreditedSubscription()
    stream.output(9)

    await stream.ack(stream.subscribed.streamToken, CHUNK, 'other-device')
    await stream.ack('stale-token', CHUNK)
    expect(stream.sentOutputUnits()).toBe(512 * 1024)
    await stream.stop()
  })

  it("sends the PTY's last output, held or batched, when it exits", async () => {
    const stream = await startCreditedSubscription()
    stream.output(9)
    stream.output(1, 100)
    expect(stream.sentOutputUnits()).toBe(512 * 1024)

    await stream.exit()
    expect(stream.sentOutputUnits()).toBe(576 * 1024 + 100)
  })

  it('replaces overflowed output with one recovery snapshot once the window drains', async () => {
    const stream = await startCreditedSubscription()
    // 512 KiB fills the window; the next 320 KiB overflows the 256 KiB hold; 100 units wait in the batcher.
    stream.output(13)
    stream.output(1, 100)
    expect(stream.snapshotKinds()).toEqual(['scrollback'])

    await stream.ack(stream.subscribed.streamToken, 512 * 1024)
    await vi.waitFor(() => expect(stream.snapshotKinds()).toEqual(['scrollback', 'resized']))
    // The snapshot shows everything held or batched, so only output after it is sent.
    stream.output(1)
    expect(stream.sentOutputUnits()).toBe(576 * 1024)
    expect(stream.snapshotKinds()).toEqual(['scrollback', 'resized'])
    await stream.stop()
  })
})
