import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { TERMINAL_METHODS } from '../methods/terminal/terminal'
import { createSubscriptionRegistryDouble } from '../testing/subscription-registry-test-double'
import type { RuntimeTerminalWait } from '../../../../shared/runtime-terminal-contracts'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText
} from '../../../../shared/terminal/stream/terminal-stream-protocol'
import { TerminalPublishedOutputRings } from '../../terminal/output/terminal-published-output-ring'

type Listener = (data: string, meta?: { seq?: number; rawLength?: number; cwd?: string }) => void

function createHost() {
  const registry = createSubscriptionRegistryDouble()
  const rings = new TerminalPublishedOutputRings()
  const listeners = new Set<Listener>()
  const addListener = (listener: Listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  let seq = 0
  let size = { cols: 40, rows: 20 }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This partial runtime supplies the terminal RPC methods these tests invoke.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    subscribeToPtyExit: vi.fn(() => vi.fn()),
    registerRemoteTerminalViewSubscriber: () => () => {},
    requestRendererTerminalTabMount: () => false,
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    handleMobileSubscribe: vi.fn().mockResolvedValue(true),
    handleMobileUnsubscribe: vi.fn(),
    subscribeToTerminalData: (_ptyId: string, listener: Listener) => addListener(listener),
    retainPublishedTerminalOutput: (ptyId: string) =>
      rings.retain(ptyId, { seq, size: () => size, subscribe: addListener }),
    getPtyOutputSequence: () => seq,
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi.fn(async () => ({ data: 'screen', ...size, seq })),
    getTerminalSize: () => size,
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

  // Mirrors onPtyData publishing a chunk to stream subscribers.
  const output = (data: string, cwd?: string) => {
    seq += data.length
    for (const listener of listeners) {
      listener(data, { seq, rawLength: data.length, ...(cwd ? { cwd } : {}) })
    }
  }

  const subscribe = async (resume?: { streamToken: string; units: number }) => {
    const frames: Uint8Array<ArrayBufferLike>[] = []
    const messages: string[] = []
    const done = dispatcher.dispatchStreaming(
      {
        id: 'sub',
        authToken: 'tok',
        method: 'terminal.subscribe',
        params: {
          terminal: 'terminal-1',
          client: { id: 'phone-1', type: 'mobile' },
          capabilities: { terminalBinaryStream: 1, outputAck: 1 },
          ...(resume ? { resume } : {})
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
    const decoded = () => frames.map((bytes) => decodeTerminalStreamFrame(bytes)!)
    const received = () =>
      decoded()
        .filter((frame) => frame.opcode === TerminalStreamOpcode.Output)
        .map((frame) => decodeTerminalStreamText(frame.payload))
        .join('')
    return {
      subscribed,
      received,
      cwds: () =>
        decoded().flatMap((frame) =>
          frame.opcode === TerminalStreamOpcode.Metadata
            ? [decodeTerminalStreamJson<{ cwd: string }>(frame.payload)?.cwd]
            : []
        ),
      // Output leaves through the stream's batcher, so wait for it rather than reading at once.
      receives: (text: string) => vi.waitFor(() => expect(received()).toBe(text)),
      snapshotKinds: () =>
        decoded().flatMap((frame) =>
          frame.opcode === TerminalStreamOpcode.SnapshotStart
            ? [decodeTerminalStreamJson<{ kind: string }>(frame.payload)?.kind]
            : []
        ),
      stop: async () => {
        runtime.cleanupSubscription('terminal-1:phone-1')
        await done
      }
    }
  }

  return {
    output,
    subscribe,
    resize: (next: { cols: number; rows: number }) => {
      size = next
    },
    // What a respawn does to the ring (advancePtyLifecycleGeneration).
    resetCoverage: () => rings.get('pty-1')?.resetCoverage(seq)
  }
}

/** A phone stream that received 'hello ' and 'world', then ended while 'again' was printed. */
async function endedStream() {
  const host = createHost()
  const first = await host.subscribe()
  host.output('hello ')
  await first.receives('hello ')
  host.output('world')
  await first.receives('hello world')
  await first.stop()
  host.output('again')
  const token: string = first.subscribed.streamToken
  return { host, token, units: 11 }
}

describe('terminal.subscribe resume', () => {
  it('sends only the missed output, then the next resume works from the new token', async () => {
    const { host, token, units } = await endedStream()

    const second = await host.subscribe({ streamToken: token, units })
    expect(second.subscribed).toMatchObject({ resumed: true, streamToken: expect.any(String) })
    await second.receives('again')
    expect(second.snapshotKinds()).toEqual([])

    host.output('!')
    await second.receives('again!')
    await second.stop()
    host.output('?')
    const third = await host.subscribe({ streamToken: second.subscribed.streamToken, units: 6 })
    expect(third.subscribed.resumed).toBe(true)
    await third.receives('?')
    await third.stop()
  })

  it('leaves reply queries out of the missed output', async () => {
    const host = createHost()
    const first = await host.subscribe()
    host.output('ready')
    await first.receives('ready')
    await first.stop()
    host.output('a\x1b[cb\x1b[?2031h')

    const second = await host.subscribe({ streamToken: first.subscribed.streamToken, units: 5 })
    expect(second.subscribed.resumed).toBe(true)
    await second.receives('ab\x1b[?2031h')
    await second.stop()
  })

  it('sends a snapshot after a coverage reset while the stream was live, as on a clear', async () => {
    const host = createHost()
    const first = await host.subscribe()
    host.output('hello ')
    await first.receives('hello ')
    host.resetCoverage()
    host.output('after')
    await first.receives('hello after')
    await first.stop()

    const next = await host.subscribe({ streamToken: first.subscribed.streamToken, units: 11 })
    expect(next.subscribed.resumed).toBeUndefined()
    expect(next.snapshotKinds()).toEqual(['scrollback'])
    await next.stop()
  })

  it.each([
    [
      'a reused token',
      async ({ host, token, units }: Awaited<ReturnType<typeof endedStream>>) => {
        const used = await host.subscribe({ streamToken: token, units })
        await used.stop()
      }
    ],
    [
      'a resize',
      async ({ host }: Awaited<ReturnType<typeof endedStream>>) => {
        host.resize({ cols: 80, rows: 20 })
        host.output('wide')
      }
    ],
    [
      'a coverage reset, as on respawn',
      async ({ host }: Awaited<ReturnType<typeof endedStream>>) => {
        host.resetCoverage()
        host.output('reborn')
      }
    ]
  ])('sends a snapshot after %s', async (_name, disrupt) => {
    const ended = await endedStream()
    await disrupt(ended)

    const next = await ended.host.subscribe({ streamToken: ended.token, units: ended.units })
    expect(next.subscribed.resumed).toBeUndefined()
    expect(next.snapshotKinds()).toEqual(['scrollback'])
    await next.stop()
  })
})
