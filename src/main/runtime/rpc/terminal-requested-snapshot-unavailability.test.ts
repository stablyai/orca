import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
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

type SerializedBuffer = { data: string; cols: number; rows: number } | null
type SnapshotStartPayload = Record<string, unknown>

// Why: 256 KiB is the pending-output budget, so this many 1 KiB chunks always trips the overflow guard.
const OVERFLOW_CHUNKS = 400

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

/** Drives one desktop multiplex stream up to a requested-snapshot reply and returns its SnapshotStart payload. */
async function requestSnapshotReply(options: {
  connectionId: string
  /** Called for each requested-snapshot serialization attempt (attempt 1 is the initial subscribe snapshot). */
  serializeRequested: (attempt: number) => Promise<SerializedBuffer>
  /** Runs while a requested-snapshot serialization is in flight, e.g. to flood pending output. */
  duringSerialize?: (attempt: number, pushOutput: (data: string) => void) => void
}): Promise<{ start: SnapshotStartPayload; chunks: string }> {
  const messages: string[] = []
  const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
  const handlers = new Map<
    number,
    (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
  >()
  const cleanups = new Map<string, () => void>()
  const dataListenerRef: { current?: (data: string) => void } = {}
  let attempt = 0
  const serializeTerminalBuffer = vi.fn(async () => {
    attempt += 1
    if (attempt === 1) {
      return { data: 'initial', cols: 120, rows: 40 }
    }
    const requestedAttempt = attempt - 1
    options.duringSerialize?.(requestedAttempt, (data) => dataListenerRef.current?.(data))
    return options.serializeRequested(requestedAttempt)
  })
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    registerRemoteTerminalViewSubscriber: () => () => {},
    resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    requestRendererTerminalTabMount: vi.fn().mockReturnValue(true),
    updateRemoteDesktopViewer: vi.fn().mockResolvedValue(true),
    unregisterRemoteDesktopViewer: vi.fn().mockResolvedValue(true),
    unregisterRemoteDesktopViewers: vi.fn().mockResolvedValue(true),
    isPtyResizeDrivenRemotely: vi.fn().mockReturnValue(false),
    getRemoteDesktopFitHold: vi.fn().mockReturnValue({ mode: 'desktop-fit', cols: 120, rows: 40 }),
    isRemoteDesktopViewerOwner: vi.fn().mockReturnValue(false),
    getPtyOutputSequence: vi.fn().mockReturnValue(0),
    serializeTerminalBuffer,
    serializeAuthoritativeTerminalBuffer: serializeTerminalBuffer,
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    subscribeToTerminalData: vi.fn((_: string, listener: (data: string) => void) => {
      dataListenerRef.current = listener
      return vi.fn()
    }),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
    getTerminalFitOverride: vi.fn().mockReturnValue(null),
    getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
    registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
      cleanups.set(id, cleanup)
    }),
    cleanupSubscription: vi.fn((id: string) => cleanups.get(id)?.()),
    waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
    updateDesktopViewport: vi.fn().mockResolvedValue(true)
  } as unknown as OrcaRuntimeService

  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const dispatchPromise = dispatcher.dispatchStreaming(
    makeRequest('terminal.multiplex', {}),
    (msg) => messages.push(msg),
    {
      connectionId: options.connectionId,
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
          streamId: 12,
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
  const framesBeforeRequest = binaryFrames.length

  handlers.get(12)?.(
    decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.SnapshotRequest,
        streamId: 12,
        seq: 2,
        payload: encodeTerminalStreamJson({ requestId: 77, scrollbackRows: 5000 })
      })
    )!
  )

  await vi.waitFor(() =>
    expect(
      binaryFrames
        .slice(framesBeforeRequest)
        .map((frame) => decodeTerminalStreamFrame(frame))
        .some((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotEnd)
    ).toBe(true)
  )
  const replyFrames = binaryFrames
    .slice(framesBeforeRequest)
    .map((frame) => decodeTerminalStreamFrame(frame))
  const start = replyFrames.find((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotStart)!
  cleanups.get(`terminal-multiplex:${options.connectionId}`)?.()
  await dispatchPromise
  return {
    start: decodeTerminalStreamJson<SnapshotStartPayload>(start.payload)!,
    chunks: replyFrames
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
      .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
      .join('')
  }
}

describe('requested terminal snapshot unavailability reasons', () => {
  it('omits a reason when the host serialized a real buffer', async () => {
    const { start, chunks } = await requestSnapshotReply({
      connectionId: 'conn-reason-success',
      serializeRequested: async () => ({ data: 'restored output', cols: 120, rows: 40 })
    })
    expect(chunks).toBe('restored output')
    expect(start).toMatchObject({ requestId: 77, truncated: false })
    expect(start.unavailable).toBeUndefined()
  })

  it('omits a reason for a proven-empty buffer so absence stays distinguishable from failure', async () => {
    const { start, chunks } = await requestSnapshotReply({
      connectionId: 'conn-reason-empty',
      serializeRequested: async () => ({ data: '', cols: 120, rows: 40 })
    })
    expect(chunks).toBe('')
    expect(start).toMatchObject({ requestId: 77, truncated: false })
    expect(start.unavailable).toBeUndefined()
  })

  it('reports no-serializable-buffer when no serializer answered', async () => {
    const { start, chunks } = await requestSnapshotReply({
      connectionId: 'conn-reason-null',
      serializeRequested: async () => null
    })
    expect(chunks).toBe('')
    // Legacy fields stay exactly as an old client expects them.
    expect(start).toMatchObject({
      requestId: 77,
      truncated: false,
      cols: 120,
      rows: 40,
      unavailable: 'no-serializable-buffer'
    })
  })

  it('reports pending-output-overflowed when the retry also overflowed', async () => {
    const { start, chunks } = await requestSnapshotReply({
      connectionId: 'conn-reason-overflow',
      serializeRequested: async () => ({ data: 'never delivered', cols: 120, rows: 40 }),
      duringSerialize: (_attempt, pushOutput) => {
        for (let index = 0; index < OVERFLOW_CHUNKS; index += 1) {
          pushOutput(String(index).padStart(3, '0') + 'x'.repeat(1021))
        }
      }
    })
    expect(chunks).toBe('')
    expect(start).toMatchObject({
      requestId: 77,
      truncated: true,
      truncatedByByteBudget: false,
      unavailable: 'pending-output-overflowed'
    })
  })

  it('recovers without a reason when only the first attempt overflowed', async () => {
    const { start, chunks } = await requestSnapshotReply({
      connectionId: 'conn-reason-overflow-once',
      serializeRequested: async () => ({ data: 'retry snapshot', cols: 120, rows: 40 }),
      duringSerialize: (attempt, pushOutput) => {
        if (attempt > 1) {
          return
        }
        for (let index = 0; index < OVERFLOW_CHUNKS; index += 1) {
          pushOutput(String(index).padStart(3, '0') + 'x'.repeat(1021))
        }
      }
    })
    expect(chunks).toBe('retry snapshot')
    expect(start).toMatchObject({ requestId: 77, truncated: false })
    expect(start.unavailable).toBeUndefined()
  })
})
