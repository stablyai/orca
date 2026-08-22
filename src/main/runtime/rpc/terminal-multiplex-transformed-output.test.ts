import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService, RuntimeTerminalDataMeta } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'
import { TERMINAL_STREAM_CHUNK_BYTES } from '../../../shared/terminal-multiplex-flow-control'

const STREAM_ID = 7

type DataListener = (data: string, meta?: RuntimeTerminalDataMeta) => void

function startMultiplexHarness() {
  const messages: string[] = []
  const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
  const handlers = new Map<
    number,
    (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
  >()
  const cleanups = new Map<string, () => void>()
  let dataListener: DataListener | undefined
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    registerRemoteTerminalViewSubscriber: () => () => {},
    // Why: a mobile-typed multiplex peer routes through these; without them the subscribe throws
    // before any output is emitted, which would hide the frame assertions rather than test them.
    handleMobileSubscribe: vi.fn().mockResolvedValue(undefined),
    handleMobileUnsubscribe: vi.fn(),
    updateMobileViewport: vi.fn().mockResolvedValue({ updated: false, applied: false }),
    resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    requestRendererTerminalTabMount: vi.fn().mockReturnValue(true),
    updateRemoteDesktopViewer: vi.fn().mockResolvedValue(true),
    unregisterRemoteDesktopViewer: vi.fn().mockResolvedValue(true),
    unregisterRemoteDesktopViewers: vi.fn().mockResolvedValue(true),
    isPtyResizeDrivenRemotely: vi.fn().mockReturnValue(false),
    getRemoteDesktopFitHold: vi.fn().mockReturnValue({ mode: 'desktop-fit', cols: 120, rows: 40 }),
    isRemoteDesktopViewerOwner: vi.fn().mockReturnValue(false),
    getPtyOutputSequence: vi.fn().mockReturnValue(0),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi
      .fn()
      .mockResolvedValue({ data: 'snapshot', cols: 120, rows: 40, source: 'headless', seq: 0 }),
    serializeAuthoritativeTerminalBuffer: vi
      .fn()
      .mockResolvedValue({ data: 'snapshot', cols: 120, rows: 40, source: 'headless', seq: 0 }),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    subscribeToTerminalData: vi.fn((_ptyId: string, listener: DataListener) => {
      dataListener = listener
      return vi.fn()
    }),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
    getTerminalFitOverride: vi.fn().mockReturnValue(null),
    getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
    attachRemoteTerminalSourceRangeConsumer: vi.fn(() => true),
    settleRemoteTerminalSourceRanges: vi.fn(),
    cancelRemoteTerminalSourceRanges: vi.fn(),
    reserveRemoteTerminalSourceRangeReplacement: vi.fn(() => null),
    commitRemoteTerminalSourceRangeReplacement: vi.fn(() => true),
    rollbackRemoteTerminalSourceRangeReplacement: vi.fn(() => true),
    registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
      cleanups.set(id, cleanup)
    }),
    cleanupSubscription: vi.fn((id: string) => {
      cleanups.get(id)?.()
    }),
    waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
  } as unknown as OrcaRuntimeService

  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const request: RpcRequest = {
    id: 'req-1',
    authToken: 'tok',
    method: 'terminal.multiplex',
    params: {}
  }
  const dispatchPromise = dispatcher.dispatchStreaming(request, (msg) => messages.push(msg), {
    connectionId: 'conn-transformed-output',
    sendBinary: (bytes) => {
      binaryFrames.push(bytes)
      return true
    },
    registerBinaryStreamHandler: (streamId, handler) => {
      handlers.set(streamId, handler)
      return () => {
        if (handlers.get(streamId) === handler) {
          handlers.delete(streamId)
        }
      }
    }
  })

  return {
    messages,
    binaryFrames,
    handlers,
    cleanups,
    runtime,
    dispatchPromise,
    getDataListener: () => dataListener,
    events: () => messages.map((message) => JSON.parse(message).result).filter(Boolean),
    outputFrames: () =>
      binaryFrames
        .map(decodeTerminalStreamFrame)
        .filter(
          (frame) =>
            frame?.opcode === TerminalStreamOpcode.Output ||
            frame?.opcode === TerminalStreamOpcode.OutputSpan
        )
        .map((frame) => frame!)
  }
}

async function subscribe(
  harness: ReturnType<typeof startMultiplexHarness>,
  capabilities: Record<string, 1>,
  client: { id: string; type: 'desktop' | 'mobile' } = { id: 'desktop-1', type: 'desktop' }
) {
  await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
  harness.handlers.get(0)?.(
    decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Subscribe,
        streamId: 0,
        seq: 1,
        payload: encodeTerminalStreamJson({
          streamId: STREAM_ID,
          terminal: 'terminal-1',
          client,
          capabilities,
          viewport: { cols: 120, rows: 40 }
        })
      })
    )!
  )
  await vi.waitFor(() =>
    expect(harness.events().some((event) => event?.type === 'subscribed')).toBe(true)
  )
  await vi.waitFor(() => expect(harness.getDataListener()).toBeDefined())
  harness.binaryFrames.splice(0)
  return harness.events().find((event) => event?.type === 'subscribed')
}

function sourceRange(displayStart: number, displayEnd: number, sourceStart = displayStart) {
  const sourceEnd = sourceStart + (displayEnd - displayStart)
  return {
    id: 'pty-1',
    spanId: `span-${displayStart}-${displayEnd}`,
    providerGeneration: 5,
    clientGeneration: 2,
    ownerGeneration: 3,
    ptyIncarnation: 'incarnation-1',
    deliveryToken: 'token-1',
    sourceStartSu: sourceStart,
    sourceEndSu: sourceEnd,
    displayStart,
    displayEnd,
    splittable: true,
    transform: { transformed: false, rawLengthSu: sourceEnd - sourceStart, scalarSafe: true }
  } as const
}

function renderedText(harness: ReturnType<typeof startMultiplexHarness>): string {
  return harness
    .outputFrames()
    .map((frame) =>
      frame.opcode === TerminalStreamOpcode.OutputSpan
        ? ((decodeTerminalStreamJson<{ data?: string }>(frame.payload)?.data ?? '') as string)
        : decodeTerminalStreamText(frame.payload)
    )
    .join('')
}

// Desktop's real multiplex capability set as shipped since 2026-07-29 (#11005).
const SHIPPED_DESKTOP_CAPABILITIES = {
  ackOutput: 1,
  ackOutputSourceRanges: 1,
  outputPause: 1,
  writeUnavailable: 1,
  desktopViewportClaims: 1
} as const

describe('terminal multiplex transformed output', () => {
  // Why: `client.type` admits 'mobile' on this path too — `TerminalMultiplexStream.isMobile` exists
  // and terminal-multiplex.test.ts already exercises mobile multiplex streams. A mobile decoder does
  // not know opcode 15 and drops the frame silently, so sending a span here is STA-3482 on a second
  // path. Mobile keeps no seq accounting, so the text downgrade is lossless for it.
  // Why: nothing server-side stops a mobile-typed multiplex stream declaring ackOutputSourceRanges,
  // which routes every chunk through the ledger. A fully absorbed run (rawLength > 0, data === '')
  // downgrades to a zero-byte Output, the ledger's canAccept requires encodedBytes > 0, and the chunk
  // parks forever with every later frame queued behind it — the same head-block as the span-gate bug.
  it('does not head-block behind an absorbed zero-byte emission for a mobile peer', async () => {
    const harness = startMultiplexHarness()
    await subscribe(harness, { ...SHIPPED_DESKTOP_CAPABILITIES }, { id: 'phone-1', type: 'mobile' })
    harness.getDataListener()!('', { seq: 9, rawLength: 9, transformed: true })
    harness.getDataListener()!('after\r\n', { seq: 16 })

    await vi.waitFor(() =>
      expect(
        harness
          .outputFrames()
          .map((frame) => decodeTerminalStreamText(frame.payload))
          .join('')
      ).toContain('after')
    )

    harness.cleanups.get('terminal-multiplex:conn-transformed-output')?.()
  })

  it('downgrades a transformed run to text for a mobile multiplex peer', async () => {
    const harness = startMultiplexHarness()
    await subscribe(harness, { ...SHIPPED_DESKTOP_CAPABILITIES }, { id: 'phone-1', type: 'mobile' })
    harness.getDataListener()!('visible output', { seq: 12, rawLength: 9, transformed: true })

    await vi.waitFor(() => expect(harness.outputFrames().length).toBeGreaterThan(0))
    const opcodes = harness.outputFrames().map((frame) => frame.opcode)
    expect(opcodes).not.toContain(TerminalStreamOpcode.OutputSpan)
    // The text must still arrive — the failure this guards is silent loss, not a suppressed frame.
    expect(
      harness
        .outputFrames()
        .map((frame) => decodeTerminalStreamText(frame.payload))
        .join('')
    ).toContain('visible output')

    harness.cleanups.get('terminal-multiplex:conn-transformed-output')?.()
  })

  // OutputSpan (opcode 15) shipped on this path in v1.4.147 (2026-07-19), before every
  // capability a peer could declare to prove it decodes spans. Keying spans off any
  // declared capability therefore reads the whole installed base as incapable.
  it.each([
    ['no capabilities at all', {}],
    ['the pre-source-range capability set', { ackOutput: 1 } as Record<string, 1>],
    ['the shipped desktop capability set', { ...SHIPPED_DESKTOP_CAPABILITIES }]
  ])('sends OutputSpan for a transformed run with %s', async (_label, capabilities) => {
    const harness = startMultiplexHarness()
    await subscribe(harness, capabilities)
    harness.getDataListener()!('xyz', { seq: 12, rawLength: 9, transformed: true })

    await vi.waitFor(() =>
      expect(harness.outputFrames().map((frame) => frame.opcode)).toContain(
        TerminalStreamOpcode.OutputSpan
      )
    )
    const span = harness
      .outputFrames()
      .find((frame) => frame.opcode === TerminalStreamOpcode.OutputSpan)!
    expect(decodeTerminalStreamJson(span.payload)).toMatchObject({
      data: 'xyz',
      rawLength: 9,
      transformed: true
    })

    harness.cleanups.get('terminal-multiplex:conn-transformed-output')?.()
    await harness.dispatchPromise
  })

  it('does not head-block the ack queue behind an absorbed zero-byte emission', async () => {
    const harness = startMultiplexHarness()
    await subscribe(harness, { ...SHIPPED_DESKTOP_CAPABILITIES })
    const emit = harness.getDataListener()!

    // The absorbed-query shape: nine raw units consumed, nothing to display.
    emit('', { seq: 9, rawLength: 9, transformed: true })
    emit('after\r\n', { seq: 16, rawLength: 7 })

    await vi.waitFor(() => expect(renderedText(harness)).toContain('after'))

    harness.cleanups.get('terminal-multiplex:conn-transformed-output')?.()
    await harness.dispatchPromise
  })

  it('keeps a transformed emission mappable so the client cannot see a false gap', async () => {
    const harness = startMultiplexHarness()
    await subscribe(harness, { ...SHIPPED_DESKTOP_CAPABILITIES })
    const emit = harness.getDataListener()!

    emit('abc', { seq: 3, rawLength: 3 })
    await vi.waitFor(() => expect(renderedText(harness)).toContain('abc'))
    // Three display units standing in for nine raw units.
    emit('xyz', { seq: 12, rawLength: 9, transformed: true })
    await vi.waitFor(() => expect(renderedText(harness)).toContain('xyz'))

    // A client reconstructs the run start as `seq - rawLength`. On a plain Output
    // frame it can only use `data.length`, so a downgraded transformed run reports
    // a start past the previous high-water and reads as a dropped-frame gap.
    const frames = harness.outputFrames()
    let expectedSeq: number | undefined
    for (const frame of frames) {
      const seq = frame.seq > 0 ? frame.seq : undefined
      const rawLength =
        frame.opcode === TerminalStreamOpcode.OutputSpan
          ? (decodeTerminalStreamJson<{ rawLength?: number }>(frame.payload)?.rawLength ?? 0)
          : decodeTerminalStreamText(frame.payload).length
      if (typeof seq === 'number' && typeof expectedSeq === 'number') {
        expect(seq - rawLength).toBeLessThanOrEqual(expectedSeq)
      }
      if (typeof seq === 'number') {
        expectedSeq = seq
      }
    }

    harness.cleanups.get('terminal-multiplex:conn-transformed-output')?.()
    await harness.dispatchPromise
  })

  it('keeps the stream attached for a transformed emission larger than one chunk', async () => {
    const harness = startMultiplexHarness()
    await subscribe(harness, { ...SHIPPED_DESKTOP_CAPABILITIES })
    const emit = harness.getDataListener()!

    emit('abc', { seq: 3, rawLength: 3, sourceRanges: [sourceRange(0, 3)] })
    await vi.waitFor(() => expect(renderedText(harness)).toContain('abc'))

    const large = 'L'.repeat(TERMINAL_STREAM_CHUNK_BYTES * 2 + 5)
    emit(large, {
      seq: 3 + large.length * 3,
      rawLength: large.length * 3,
      transformed: true,
      sourceRanges: [sourceRange(3, 3 + large.length, 3)]
    })

    await vi.waitFor(() => expect(renderedText(harness).length).toBeGreaterThan(large.length))
    expect(renderedText(harness)).toBe(`abc${large}`)
    // A mapping-mode flip mid-stream detaches the stream and ends it.
    expect(harness.events().some((event) => event?.type === 'end')).toBe(false)

    harness.cleanups.get('terminal-multiplex:conn-transformed-output')?.()
    await harness.dispatchPromise
  })
})
