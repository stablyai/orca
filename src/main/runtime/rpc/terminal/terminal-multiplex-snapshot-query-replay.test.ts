import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimeTerminalDataMeta } from '../../terminal/output/runtime-terminal-stream-consumers'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../../shared/terminal/stream/terminal-stream-protocol'
import {
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe
} from './testing/terminal-multiplex-test-harness'
import { TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES } from '../../../../shared/terminal/stream/terminal-multiplex-flow-control'

afterEach(() => vi.useRealTimers())

type ReleaseHeldSnapshot = (extra?: { pendingEscapeTailAnsi?: string }) => void

async function startSoleQueryOwnerStream() {
  let listener: ((data: string, meta?: RuntimeTerminalDataMeta) => void) | undefined
  let seq = 0
  let holdNextSnapshot = false
  let releaseSnapshot: ReleaseHeldSnapshot | undefined
  const answerYieldedTerminalQueries = vi.fn()
  const harness = startDesktopMultiplexSubscribe({
    isSoleRemoteTerminalQueryOwner: () => true,
    answerYieldedTerminalQueries,
    serializeTerminalBuffer: vi.fn(async () => {
      if (!holdNextSnapshot) {
        return { data: '', cols: 80, rows: 24, seq }
      }
      holdNextSnapshot = false
      return new Promise<{
        data: string
        cols: number
        rows: number
        seq: number
        pendingEscapeTailAnsi?: string
      }>((resolve) => {
        releaseSnapshot = (extra) => resolve({ data: '', cols: 80, rows: 24, seq, ...extra })
      })
    }),
    subscribeToTerminalData: vi.fn((_ptyId, onData) => {
      listener = onData
      return vi.fn()
    })
  })
  await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
  return {
    answerYieldedTerminalQueries,
    holdNextSnapshot: (): void => {
      holdNextSnapshot = true
    },
    held: async (): Promise<ReleaseHeldSnapshot> => {
      await vi.waitFor(() => expect(releaseSnapshot).toBeDefined())
      const release = releaseSnapshot!
      releaseSnapshot = undefined
      return release
    },
    subscribe: async (): Promise<void> => {
      sendDesktopMultiplexSubscribe(harness.handlers)
      await vi.waitFor(() => expect(listener).toBeDefined())
    },
    waitSubscribed: () =>
      vi.waitFor(() =>
        expect(
          harness.messages.some((message) => JSON.parse(message).result?.type === 'subscribed')
        ).toBe(true)
      ),
    send: (opcode: TerminalStreamOpcode, payload: Record<string, unknown>): void => {
      harness.handlers.get(7)?.(
        decodeTerminalStreamFrame(
          encodeTerminalStreamFrame({
            opcode,
            streamId: 7,
            seq: 2,
            payload: encodeTerminalStreamJson(payload)
          })
        )!
      )
    },
    emit: async (data: string, { holdInBatcher = false } = {}): Promise<void> => {
      seq += data.length
      listener?.(data, { seq, rawLength: data.length })
      if (!holdInBatcher) {
        await vi.runOnlyPendingTimersAsync()
      }
    },
    currentSeq: (): number => seq,
    snapshotEndCount: (): number =>
      harness.binaryFrames
        .map(decodeTerminalStreamFrame)
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotEnd).length,
    /** `viewerCutoffSeq` mirrors the viewer dropping seq'd output its recovery snapshot covers. */
    outputAfterLastSnapshot: (viewerCutoffSeq = 0): string => {
      const frames = harness.binaryFrames.map(decodeTerminalStreamFrame)
      const snapshotEnd = frames.findLastIndex(
        (frame) => frame?.opcode === TerminalStreamOpcode.SnapshotEnd
      )
      return frames
        .slice(snapshotEnd + 1)
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
        .filter((frame) => !frame?.seq || frame.seq > viewerCutoffSeq)
        .map((frame) => frame && decodeTerminalStreamText(frame.payload))
        .join('')
    },
    cleanup: async (): Promise<void> => {
      harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
      await harness.dispatchPromise
    }
  }
}

it('drops a superseded snapshot replay and its escape tail queued behind the ACK window', async () => {
  vi.useFakeTimers()
  const stream = await startSoleQueryOwnerStream()
  try {
    await stream.subscribe()
    await stream.waitSubscribed()
    await stream.emit('x'.repeat(TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES))
    stream.holdNextSnapshot()
    stream.send(TerminalStreamOpcode.SnapshotRequest, {})
    const release = await stream.held()
    await stream.emit('\x1b[c\x1b[31')
    release({ pendingEscapeTailAnsi: '\x1b[31' })
    await vi.runOnlyPendingTimersAsync()
    stream.send(TerminalStreamOpcode.SnapshotRequest, {})
    await vi.runOnlyPendingTimersAsync()
    stream.send(TerminalStreamOpcode.Ack, {
      bytes: TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES
    })
    await vi.runOnlyPendingTimersAsync()

    expect(stream.outputAfterLastSnapshot()).toBe('\x1b[c')
    expect(stream.answerYieldedTerminalQueries).not.toHaveBeenCalled()
  } finally {
    await stream.cleanup()
  }
})
