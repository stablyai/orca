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

// An untagged SnapshotRequest is the client's frame-drop resync: its reply
// resets the client terminal to the snapshot's output high-water. Output
// buffered while the snapshot serialized is already inside that snapshot up to
// its seq, so replaying the covered bytes afterward renders the recovered tail
// twice. A tagged (requestId) snapshot feeds a side consumer instead — the
// live view still needs every buffered chunk, so that replay must stay whole.

type OutputMeta = { seq?: number; rawLength?: number }

async function setupMultiplexStream(): Promise<{
  binaryFrames: Uint8Array<ArrayBufferLike>[]
  sendClientFrame: (opcode: TerminalStreamOpcode, payload: Uint8Array<ArrayBufferLike>) => void
  emitOutput: (data: string, meta?: OutputMeta) => void
  setSnapshot: (snapshot: { data: string; seq?: number }) => void
  deferNextSerialize: () => void
  releaseSerialize: () => Promise<void>
  finish: () => Promise<void>
}> {
  const messages: string[] = []
  const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
  const handlers = new Map<
    number,
    (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
  >()
  const cleanups = new Map<string, () => void>()
  let emitOutput: ((data: string, meta?: OutputMeta) => void) | null = null
  let snapshot: { data: string; seq?: number } = { data: 'INITIAL', seq: 0 }
  let deferSerialize = false
  let releaseDeferredSerialize: (() => void) | null = null

  const runtime = {
    getRuntimeId: () => 'test-runtime',
    resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi.fn(async () => {
      if (deferSerialize) {
        deferSerialize = false
        await new Promise<void>((resolve) => {
          releaseDeferredSerialize = resolve
        })
      }
      return { data: snapshot.data, cols: 80, rows: 24, seq: snapshot.seq }
    }),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    registerRemoteTerminalViewSubscriber: vi.fn(() => () => {}),
    subscribeToTerminalData: vi.fn(
      (_ptyId: string, cb: (data: string, meta?: OutputMeta) => void) => {
        emitOutput = cb
        return vi.fn()
      }
    ),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    subscribeToDriverChanges: vi.fn().mockReturnValue(vi.fn()),
    getTerminalFitOverride: vi.fn().mockReturnValue(null),
    getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
    registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
      cleanups.set(id, cleanup)
    }),
    cleanupSubscription: vi.fn((id: string) => {
      const cleanup = cleanups.get(id)
      cleanups.delete(id)
      cleanup?.()
    }),
    waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
    updateDesktopViewport: vi.fn().mockResolvedValue(true)
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

  const request: RpcRequest = {
    id: 'req-1',
    authToken: 'tok',
    method: 'terminal.multiplex',
    params: {}
  }
  const dispatchPromise = dispatcher.dispatchStreaming(request, (msg) => messages.push(msg), {
    connectionId: 'conn-1',
    sendBinary: (bytes) => {
      binaryFrames.push(bytes)
    },
    registerBinaryStreamHandler: (streamId, handler) => {
      handlers.set(streamId, handler)
      return () => handlers.delete(streamId)
    }
  })

  await vi.runOnlyPendingTimersAsync()
  expect(messages.some((msg) => JSON.parse(msg).result?.type === 'ready')).toBe(true)

  handlers.get(0)?.(
    decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Subscribe,
        streamId: 0,
        seq: 1,
        payload: encodeTerminalStreamJson({
          streamId: 5,
          terminal: 'terminal-1',
          client: { id: 'desktop-1', type: 'desktop' }
        })
      })
    )!
  )
  for (let i = 0; i < 5; i += 1) {
    await vi.runOnlyPendingTimersAsync()
  }
  expect(emitOutput).not.toBeNull()

  return {
    binaryFrames,
    sendClientFrame: (opcode, payload) => {
      handlers.get(5)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({ opcode, streamId: 5, seq: 1, payload })
        )!
      )
    },
    emitOutput: (data, meta) => emitOutput!(data, meta),
    setSnapshot: (next) => {
      snapshot = next
    },
    deferNextSerialize: () => {
      deferSerialize = true
    },
    releaseSerialize: async () => {
      releaseDeferredSerialize?.()
      releaseDeferredSerialize = null
      for (let i = 0; i < 5; i += 1) {
        await vi.runOnlyPendingTimersAsync()
      }
    },
    finish: async () => {
      runtime.cleanupSubscription('terminal-multiplex:conn-1')
      await dispatchPromise
    }
  }
}

function outputTextsAfterLastSnapshotEnd(frames: Uint8Array<ArrayBufferLike>[]): string[] {
  const decoded = frames.map((frame) => decodeTerminalStreamFrame(frame))
  const lastEnd = decoded.reduce(
    (last, frame, index) => (frame?.opcode === TerminalStreamOpcode.SnapshotEnd ? index : last),
    -1
  )
  return decoded.slice(lastEnd + 1).flatMap((frame) => {
    if (frame?.opcode === TerminalStreamOpcode.Output) {
      return [decodeTerminalStreamText(frame.payload)]
    }
    if (frame?.opcode === TerminalStreamOpcode.OutputSpan) {
      return [decodeTerminalStreamJson<{ data?: string }>(frame.payload)?.data ?? '']
    }
    return []
  })
}

describe('terminal.multiplex requested-snapshot replay trim', () => {
  it('drops snapshot-covered buffered output after an untagged resync reply', async () => {
    vi.useFakeTimers()
    try {
      const harness = await setupMultiplexStream()

      harness.setSnapshot({ data: 'RECOVERED', seq: 12 })
      harness.deferNextSerialize()
      harness.sendClientFrame(TerminalStreamOpcode.SnapshotRequest, encodeTerminalStreamJson({}))
      // Buffered while the snapshot serialized: fully covered by seq 12, and a
      // partial chunk straddling the boundary whose tail the client still needs.
      harness.emitOutput('xxx', { seq: 9, rawLength: 3 })
      harness.emitOutput('bbbccc', { seq: 15, rawLength: 6 })
      await harness.releaseSerialize()

      const snapshotStart = harness.binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .findLast((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotStart)!
      expect(decodeTerminalStreamJson(snapshotStart.payload)).toMatchObject({ seq: 12 })
      expect(outputTextsAfterLastSnapshotEnd(harness.binaryFrames).join('')).toBe('ccc')

      await harness.finish()
    } finally {
      vi.useRealTimers()
    }
  })

  it('replays all buffered output untouched after a tagged snapshot reply', async () => {
    vi.useFakeTimers()
    try {
      const harness = await setupMultiplexStream()

      harness.setSnapshot({ data: 'MANUAL', seq: 12 })
      harness.deferNextSerialize()
      harness.sendClientFrame(
        TerminalStreamOpcode.SnapshotRequest,
        encodeTerminalStreamJson({ requestId: 7 })
      )
      harness.emitOutput('xxx', { seq: 9, rawLength: 3 })
      harness.emitOutput('bbbccc', { seq: 15, rawLength: 6 })
      await harness.releaseSerialize()

      const snapshotStart = harness.binaryFrames
        .map((frame) => decodeTerminalStreamFrame(frame))
        .findLast((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotStart)!
      expect(decodeTerminalStreamJson(snapshotStart.payload)).toMatchObject({ requestId: 7 })
      expect(outputTextsAfterLastSnapshotEnd(harness.binaryFrames).join('')).toBe('xxxbbbccc')

      await harness.finish()
    } finally {
      vi.useRealTimers()
    }
  })
})
