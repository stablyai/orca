import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import { TERMINAL_STREAM_CHUNK_BYTES } from '../../../shared/terminal-multiplex-flow-control'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

type TerminalDataMeta = {
  seq?: number
  rawLength?: number
  transformed?: boolean
  cwd?: string
}

type LegacyStreamHarness = {
  binaryFrames: Uint8Array<ArrayBufferLike>[]
  emit: (data: string, meta?: TerminalDataMeta) => void
  dispatchPromise: Promise<unknown>
  cleanup: () => void
}

function sharedOpcodes(): Set<number> {
  return new Set(
    Object.values(TerminalStreamOpcode).filter(
      (value): value is number => typeof value === 'number'
    )
  )
}

// Why parsed from mobile's source instead of hard-coded: mobile is a separate pnpm
// workspace, so its transport module cannot be imported from here. Reading the real
// file is what makes this test fail when the two tables drift. A mobile build that
// re-exports the shared table cannot drift at all, so it inherits every opcode.
function mobileDecodableOpcodes(): Set<number> {
  const source = readFileSync(
    join(process.cwd(), 'mobile/src/transport/terminal-stream-protocol.ts'),
    'utf8'
  )
  const body = /enum TerminalStreamOpcode \{([\s\S]*?)\}/.exec(source)?.[1]
  if (!body) {
    if (/TerminalStreamOpcode[\s\S]*?['"][^'"]*shared\/terminal-stream-protocol['"]/.test(source)) {
      return sharedOpcodes()
    }
    throw new Error('mobile TerminalStreamOpcode is neither a vendored enum nor a shared re-export')
  }
  const opcodes = new Set<number>()
  for (const match of body.matchAll(/^\s*\w+\s*=\s*(\d+)/gm)) {
    opcodes.add(Number(match[1]))
  }
  if (opcodes.size === 0) {
    throw new Error('mobile vendored TerminalStreamOpcode enum parsed empty')
  }
  return opcodes
}

async function subscribeLegacyBinaryStream(
  client: { id: string; type: 'mobile' | 'desktop' },
  capabilities: Record<string, 1>
): Promise<LegacyStreamHarness> {
  const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
  const messages: string[] = []
  const cleanups = new Map<string, () => void>()
  let onData: ((data: string, meta?: TerminalDataMeta) => void) | undefined
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-span' }),
    hasHeadlessTerminalState: vi.fn(() => true),
    getRendererTerminalSerializerGeneration: vi.fn(() => 1),
    getPtyOutputSequence: vi.fn(() => 0),
    handleMobileSubscribe: vi.fn().mockResolvedValue(true),
    handleMobileUnsubscribe: vi.fn(),
    updateMobileViewport: vi.fn().mockResolvedValue(true),
    updateDesktopViewport: vi.fn().mockResolvedValue(true),
    subscribeToTerminalData: vi.fn((_ptyId: string, listener: typeof onData) => {
      onData = listener
      return vi.fn()
    }),
    registerRemoteTerminalViewSubscriber: vi.fn(() => vi.fn()),
    unregisterRemoteDesktopViewer: vi.fn(),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi.fn().mockResolvedValue(null),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
    isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
      cleanups.set(id, cleanup)
    }),
    cleanupSubscription: vi.fn((id: string) => {
      cleanups.get(id)?.()
      cleanups.delete(id)
    }),
    waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const request: RpcRequest = {
    id: `req-${client.id}`,
    authToken: 'tok',
    method: 'terminal.subscribe',
    params: { terminal: 'terminal-span', client, capabilities }
  }
  const dispatchPromise = dispatcher.dispatchStreaming(
    request,
    (message) => messages.push(message),
    {
      connectionId: `conn-${client.id}`,
      sendBinary: (bytes) => {
        binaryFrames.push(bytes)
      },
      registerBinaryStreamHandler: vi.fn(() => vi.fn())
    }
  )
  await vi.waitFor(() =>
    expect(messages.some((message) => JSON.parse(message).result?.type === 'subscribed')).toBe(true)
  )
  await vi.waitFor(() => expect(onData).toBeTypeOf('function'))
  binaryFrames.splice(0)
  return {
    binaryFrames,
    dispatchPromise,
    emit: (data, meta) => onData?.(data, meta),
    cleanup: () => runtime.cleanupSubscription(`terminal-span:${client.id}`)
  }
}

function outputTextIn(frames: readonly Uint8Array<ArrayBufferLike>[]): string {
  return frames
    .map((bytes) => decodeTerminalStreamFrame(bytes))
    .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
    .map((frame) => decodeTerminalStreamText(frame!.payload))
    .join('')
}

// A transformed emission (SSH relay / OSC-stripping): display text is shorter
// than the raw byte run it came from, which is what routes to OutputSpan.
const TRANSFORMED_META: TerminalDataMeta = { seq: 40, rawLength: 26, transformed: true }

describe('terminal.subscribe OutputSpan capability gate', () => {
  it('sends a legacy mobile client only opcodes its vendored decoder knows', async () => {
    const legacy = await subscribeLegacyBinaryStream(
      { id: 'mobile-span', type: 'mobile' },
      { terminalBinaryStream: 1 }
    )

    legacy.emit('visible output', TRANSFORMED_META)
    await vi.waitFor(() => expect(legacy.binaryFrames.length).toBeGreaterThan(0))

    const decodable = mobileDecodableOpcodes()
    const sent = legacy.binaryFrames.map((bytes) => decodeTerminalStreamFrame(bytes)!.opcode)
    expect(sent.filter((opcode) => !decodable.has(opcode))).toEqual([])

    legacy.cleanup()
    await legacy.dispatchPromise
  })

  it('preserves the transformed text for a legacy mobile client', async () => {
    const legacy = await subscribeLegacyBinaryStream(
      { id: 'mobile-text', type: 'mobile' },
      { terminalBinaryStream: 1 }
    )

    legacy.emit('visible output', TRANSFORMED_META)
    await vi.waitFor(() => expect(legacy.binaryFrames.length).toBeGreaterThan(0))

    expect(outputTextIn(legacy.binaryFrames)).toBe('visible output')

    legacy.cleanup()
    await legacy.dispatchPromise
  })

  it('still sends OutputSpan to a client that negotiated the capability', async () => {
    const capable = await subscribeLegacyBinaryStream(
      { id: 'desktop-span', type: 'desktop' },
      { terminalBinaryStream: 1, outputSpan: 1 }
    )

    capable.emit('visible output', TRANSFORMED_META)
    await vi.waitFor(() => expect(capable.binaryFrames.length).toBeGreaterThan(0))

    const spans = capable.binaryFrames
      .map((bytes) => decodeTerminalStreamFrame(bytes))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.OutputSpan)
    expect(spans).toHaveLength(1)
    expect(JSON.parse(decodeTerminalStreamText(spans[0]!.payload))).toMatchObject({
      data: 'visible output',
      rawLength: 26,
      transformed: true
    })

    capable.cleanup()
    await capable.dispatchPromise
  })

  // The downgrade's multi-frame arm. Every fixture in this suite used to be a
  // 14-character string, so the chunk loop never ran and a deleted yield here —
  // 48 KiB of silently dropped user output — passed every test in the repo.
  it('delivers a transformed emission larger than one chunk, whole and in order', async () => {
    const legacy = await subscribeLegacyBinaryStream(
      { id: 'mobile-large', type: 'mobile' },
      { terminalBinaryStream: 1 }
    )

    const data = `${'a'.repeat(TERMINAL_STREAM_CHUNK_BYTES)}MIDDLE${'b'.repeat(TERMINAL_STREAM_CHUNK_BYTES)}TAIL`
    legacy.emit(data, { seq: data.length * 3, rawLength: data.length * 3, transformed: true })
    await vi.waitFor(() => expect(outputTextIn(legacy.binaryFrames)).toHaveLength(data.length))

    // Anti-vacuous: prove the multi-chunk arm ran rather than the single-frame arm.
    const outputs = legacy.binaryFrames
      .map((bytes) => decodeTerminalStreamFrame(bytes))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
    expect(outputs.length).toBeGreaterThan(2)
    for (const frame of outputs) {
      expect(frame!.payload.byteLength).toBeLessThanOrEqual(TERMINAL_STREAM_CHUNK_BYTES)
    }
    expect(outputTextIn(legacy.binaryFrames)).toBe(data)
    // Only the last frame may carry the raw high-water mark; the others cannot map it.
    expect(outputs.at(-1)!.seq).toBe(data.length * 3)

    legacy.cleanup()
    await legacy.dispatchPromise
  })

  it('keeps delivering after an absorbed zero-byte transformed emission', async () => {
    const legacy = await subscribeLegacyBinaryStream(
      { id: 'mobile-absorbed', type: 'mobile' },
      { terminalBinaryStream: 1 }
    )

    // The absorbed-query shape: raw units consumed, nothing to display.
    legacy.emit('', { seq: 9, rawLength: 9, transformed: true })
    legacy.emit('after', { seq: 14, rawLength: 5 })
    await vi.waitFor(() => expect(outputTextIn(legacy.binaryFrames)).toBe('after'))

    const opcodes = legacy.binaryFrames.map((bytes) => decodeTerminalStreamFrame(bytes)!.opcode)
    expect(opcodes).not.toContain(TerminalStreamOpcode.OutputSpan)

    legacy.cleanup()
    await legacy.dispatchPromise
  })

  it('forces a mobile decision for every opcode in the shared table', () => {
    // The drift guard. While mobile hand-copies the enum, adding an opcode to the
    // shared table changes nothing on the phone and nothing fails. Each opcode must be
    // classified on purpose; a new one is neither "decodable" nor "gated" until someone
    // says which, and this test is where they say it.
    const decodableByMobile = mobileDecodableOpcodes()
    // Opcodes a host may never send to a mobile stream unless it negotiated them,
    // or that only ever travel client -> host.
    const notSentUnnegotiatedToMobile = new Set<number>([
      TerminalStreamOpcode.Input,
      TerminalStreamOpcode.Resize,
      TerminalStreamOpcode.Subscribe,
      TerminalStreamOpcode.Unsubscribe,
      TerminalStreamOpcode.SnapshotRequest,
      TerminalStreamOpcode.Ack,
      TerminalStreamOpcode.ClaimViewport,
      TerminalStreamOpcode.OutputSpan,
      TerminalStreamOpcode.SetOutputPaused,
      TerminalStreamOpcode.WriteUnavailable
    ])

    const unclassified = Object.values(TerminalStreamOpcode)
      .filter((value): value is number => typeof value === 'number')
      .filter((opcode) => !decodableByMobile.has(opcode))
      .filter((opcode) => !notSentUnnegotiatedToMobile.has(opcode))
    expect(unclassified).toEqual([])
  })
})
