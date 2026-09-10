import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import { SshPtyProvider } from '../../providers/ssh-pty-provider'
import { TERMINAL_METHODS } from './methods/terminal'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { TerminalOutputMeta } from './terminal-output-frame-chunks'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'
import { iterateLegacyTerminalDisplayChunks } from './methods/terminal/terminal-legacy-display-chunks'
import { createJiti } from 'jiti'

// Load the shipped codec without requiring Expo's unrelated application tsconfig.
const { handleTerminalBinaryFrame } = createJiti(import.meta.url, { moduleCache: false })(
  '../../../../mobile/src/transport/rpc-client-terminal-binary-frame.ts'
) as {
  handleTerminalBinaryFrame: (
    bytes: Uint8Array,
    options: {
      terminalSnapshots: Map<number, unknown>
      getListener: (streamId: number) => (event: unknown) => void
    }
  ) => void
}
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import { TERMINAL_STREAM_CHUNK_BYTES } from '../../../shared/terminal-multiplex-flow-control'

async function connect(outputSpan = false, mobile = true) {
  const registry = createSubscriptionRegistryDouble()
  const events: Record<string, unknown>[] = []
  const messages: Record<string, unknown>[] = []
  const frames: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>[] = []
  const terminalSnapshots = new Map()
  let dataListener!: (data: string, meta?: TerminalOutputMeta) => void
  let resizeListener!: (event: {
    cols: number
    rows: number
    displayMode: string
    reason: string
  }) => void
  let snapshot = { data: 'initial', cols: 80, rows: 24, seq: 10 }
  const runtime = {
    getRuntimeId: () => 'compatibility-runtime',
    resolveLeafForHandle: () => ({ ptyId: 'pty' }),
    readTerminal: async () => ({ tail: [], truncated: false }),
    serializeTerminalBuffer: async () => snapshot,
    serializeAuthoritativeTerminalBuffer: async () => snapshot,
    getTerminalSize: () => ({ cols: 80, rows: 24 }),
    getMobileDisplayMode: () => 'auto',
    getLayout: () => ({ seq: 1 }),
    isTerminalAlternateScreen: () => false,
    getRendererTerminalSerializerGenerationForHandle: () => 0,
    hasHeadlessTerminalState: () => true,
    handleMobileSubscribe: async () => {
      dataListener('covered', { seq: 10, rawLength: 10, transformed: true })
      dataListener('buffered🙂', { seq: 15, rawLength: 5, transformed: true })
    },
    handleMobileUnsubscribe: vi.fn(),
    subscribeToTerminalData: (_: string, listener: typeof dataListener) => {
      dataListener = listener
      return vi.fn()
    },
    subscribeToTerminalResize: (_: string, listener: typeof resizeListener) => {
      resizeListener = listener
      return vi.fn()
    },
    subscribeToFitOverrideChanges: () => vi.fn(),
    subscribeToPtyExit: () => vi.fn(),
    registerRemoteTerminalViewSubscriber: () => vi.fn(),
    registerOwnedSubscriptionCleanup: registry.registerOwnedSubscriptionCleanup,
    waitForTerminal: () => new Promise(() => {})
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const done = dispatcher.dispatchStreaming(
    {
      id: 'compatibility',
      authToken: 'fixture',
      method: 'terminal.subscribe',
      params: {
        terminal: 'term',
        client: { id: 'client', type: mobile ? 'mobile' : 'desktop' },
        capabilities: { terminalBinaryStream: 1, ...(outputSpan ? { outputSpan: 1 } : {}) }
      }
    },
    (message) => messages.push(JSON.parse(message).result),
    {
      connectionId: 'connection',
      sendBinary: (bytes) => {
        const frame = decodeTerminalStreamFrame(bytes)
        if (!frame) {
          throw new Error('Host emitted invalid frame')
        }
        frames.push(frame)
        handleTerminalBinaryFrame(new Uint8Array(bytes), {
          terminalSnapshots,
          getListener: () => (event) => events.push(event as Record<string, unknown>)
        })
      }
    }
  )
  await vi.waitFor(() => expect(resizeListener).toBeDefined())
  return {
    events,
    messages,
    frames,
    emit: (data: string, meta?: TerminalOutputMeta) => dataListener(data, meta),
    resize: () => {
      snapshot = { data: 'resized🙂', cols: 100, rows: 24, seq: 40 }
      resizeListener({ cols: 100, rows: 24, displayMode: 'auto', reason: 'apply-layout' })
    },
    close: async () => {
      registry.cleanupSubscription('term:client')
      await done
    }
  }
}

describe('legacy display publication against the shipped mobile decoder', () => {
  it('delivers initial/buffered/live/resize/reconnect text without span JSON or lost display', async () => {
    for (let connection = 0; connection < 2; connection++) {
      const peer = await connect()
      try {
        expect(peer.events.filter((e) => e.type === 'scrollback').map((e) => e.serialized)).toEqual(
          ['initial']
        )
        expect(peer.events.filter((e) => e.type === 'data').map((e) => e.chunk)).toEqual([
          'buffered🙂'
        ])
        for (const [data, rawLength] of [
          ['\u001b[31m雪🙂\u001b[0m', 30],
          ['expanded', 1],
          ['', 9]
        ] as const) {
          peer.emit(data, { seq: 40, rawLength, transformed: true, cwd: '/remote/project' })
        }
        expect(peer.events.filter((e) => e.type === 'data').map((e) => e.chunk)).toEqual([
          'buffered🙂',
          '\u001b[31m雪🙂\u001b[0m',
          'expanded',
          ''
        ])
        expect(peer.events.some((e) => e.type === 'metadata' && e.cwd === '/remote/project')).toBe(
          true
        )
        peer.resize()
        await vi.waitFor(() =>
          expect(
            peer.events.some((e) => e.type === 'resized' && e.serialized === 'resized🙂')
          ).toBe(true)
        )
        expect(peer.frames.some((f) => f.opcode === TerminalStreamOpcode.OutputSpan)).toBe(false)
        expect(peer.messages.find((e) => e.type === 'subscribed')?.capabilities).toBeUndefined()
      } finally {
        await peer.close()
      }
    }
  })

  it.each([true, false])(
    'echoes advertised spans and preserves source accounting (mobile=%s)',
    async (mobile) => {
      const peer = await connect(true, mobile)
      try {
        peer.emit('雪🙂', { seq: 101, rawLength: 17, transformed: true })
        expect(peer.messages.find((e) => e.type === 'subscribed')?.capabilities).toEqual({
          outputSpan: 1
        })
        const frame = peer.frames.at(-1)!
        expect(frame.opcode).toBe(TerminalStreamOpcode.OutputSpan)
        expect(frame.seq).toBe(101)
        expect(decodeTerminalStreamJson(frame.payload)).toEqual({
          data: '雪🙂',
          rawLength: 17,
          transformed: true
        })
      } finally {
        await peer.close()
      }
    }
  )

  it('also adapts accepted legacy desktop subscriptions without advertising spans', async () => {
    const peer = await connect(false, false)
    try {
      peer.emit('desktop', { seq: 100, rawLength: 2, transformed: true })
      expect(peer.events.filter((e) => e.type === 'data').map((e) => e.chunk)).toEqual(['desktop'])
    } finally {
      await peer.close()
    }
  })

  it('delivers transformed SSH provider notifications through the host publisher', async () => {
    const peer = await connect()
    let notify!: (method: string, params: Record<string, unknown>) => void
    const provider = new SshPtyProvider('fixture-connection', {
      request: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn(),
      onNotification: (listener: typeof notify) => {
        notify = listener
        return vi.fn()
      },
      isDisposed: () => false
    } as never)
    const unsubscribe = provider.onData((event) =>
      peer.emit(event.data, {
        seq: event.seq,
        rawLength: event.sequenceChars,
        transformed: event.transformed
      })
    )
    try {
      notify('pty.data', { id: 'pty', data: 'SSH雪🙂', seq: 90, rawLength: 50, transformed: true })
      notify('pty.data', { id: 'pty', data: '', seq: 99, rawLength: 9, transformed: true })
      expect(peer.events.filter((e) => e.type === 'data').map((e) => e.chunk)).toEqual([
        'buffered🙂',
        'SSH雪🙂',
        ''
      ])
      expect(peer.frames.some((frame) => frame.opcode === TerminalStreamOpcode.OutputSpan)).toBe(
        false
      )
    } finally {
      unsubscribe()
      await peer.close()
    }
  })

  it('bounds Unicode display chunks without fabricating source offsets or mutating metadata', () => {
    const text = '雪🙂'.repeat(TERMINAL_STREAM_CHUNK_BYTES)
    const meta = Object.freeze({ seq: 900, rawLength: 12, transformed: true })
    const chunks = [...iterateLegacyTerminalDisplayChunks(text, meta, false)]
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.bytes.length <= TERMINAL_STREAM_CHUNK_BYTES)).toBe(true)
    expect(chunks.map((chunk) => decodeTerminalStreamText(chunk.bytes)).join('')).toBe(text)
    expect(chunks.slice(0, -1).every((chunk) => chunk.seq === undefined)).toBe(true)
    expect(chunks.at(-1)?.seq).toBe(900)
    expect(meta).toEqual({ seq: 900, rawLength: 12, transformed: true })
  })
})
