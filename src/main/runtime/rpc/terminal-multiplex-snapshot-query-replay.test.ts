import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import type { RuntimeTerminalDataMeta } from '../orca-runtime'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'
import {
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe
} from './terminal-multiplex-test-harness'
import {
  TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES,
  TERMINAL_MULTIPLEX_PENDING_MAX_BYTES
} from '../../../shared/terminal-multiplex-flow-control'

afterEach(() => vi.useRealTimers())

describe.each([
  { parserState: 'ground', pending: '', suffix: 'AFTER', soleOwner: true },
  { parserState: 'CSI', pending: '\x1b[31', suffix: 'mAFTER', soleOwner: true },
  { parserState: 'OSC', pending: '\x1b]777;payload', suffix: 'end\x07AFTER', soleOwner: true },
  { parserState: 'DCS', pending: '\x1bP1qpayload', suffix: 'end\x1b\\AFTER', soleOwner: true },
  { parserState: 'ground with another owner', pending: '', suffix: 'AFTER', soleOwner: false }
])(
  'multiplex snapshot-covered queries with $parserState parser state',
  ({ pending, suffix, soleOwner }) => {
    it.each(['initial', 'requested'] as const)(
      'preserves DA1 ownership across the %s snapshot without replaying stale CPR',
      async (kind) => {
        vi.useFakeTimers()
        let output: ((data: string, meta?: RuntimeTerminalDataMeta) => void) | undefined
        let completeSnapshot:
          | ((snapshot: {
              data: string
              cols: number
              rows: number
              seq: number
              pendingEscapeTailAnsi?: string
            }) => void)
          | undefined
        let holdSnapshot = kind === 'initial'
        const answerYieldedTerminalQueries = vi.fn()
        const harness = startDesktopMultiplexSubscribe({
          isSoleRemoteTerminalQueryOwner: () => soleOwner,
          answerYieldedTerminalQueries,
          serializeTerminalBuffer: vi.fn(async () => {
            if (!holdSnapshot) {
              return { data: '', cols: 80, rows: 24, seq: 0 }
            }
            return new Promise<{
              data: string
              cols: number
              rows: number
              seq: number
              pendingEscapeTailAnsi?: string
            }>((resolve) => {
              completeSnapshot = resolve
            })
          }),
          subscribeToTerminalData: vi.fn((_ptyId, listener) => {
            output = listener
            return vi.fn()
          })
        })
        try {
          await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
          sendDesktopMultiplexSubscribe(harness.handlers)
          await vi.waitFor(() => expect(output).toBeDefined())
          if (kind === 'requested') {
            await vi.waitFor(() =>
              expect(
                harness.messages.some(
                  (message) => JSON.parse(message).result?.type === 'subscribed'
                )
              ).toBe(true)
            )
            holdSnapshot = true
            harness.handlers.get(7)?.(
              decodeTerminalStreamFrame(
                encodeTerminalStreamFrame({
                  opcode: TerminalStreamOpcode.SnapshotRequest,
                  streamId: 7,
                  seq: 2,
                  payload: encodeTerminalStreamJson({})
                })
              )!
            )
          }
          await vi.waitFor(() => expect(completeSnapshot).toBeDefined())
          const prefix = 'covered\x1b[6n\x1b['
          const finalChunk = `c${pending}${suffix}`
          const snapshotSeq = prefix.length + 1 + pending.length
          output?.(prefix, { seq: prefix.length, rawLength: prefix.length })
          output?.(finalChunk, {
            seq: prefix.length + finalChunk.length,
            rawLength: finalChunk.length
          })
          completeSnapshot?.({
            data: 'covered',
            cols: 80,
            rows: 24,
            seq: snapshotSeq,
            pendingEscapeTailAnsi: pending
          })
          await vi.runOnlyPendingTimersAsync()

          const frames = harness.binaryFrames.map(decodeTerminalStreamFrame)
          const snapshotEnd = frames.findLastIndex(
            (frame) => frame?.opcode === TerminalStreamOpcode.SnapshotEnd
          )
          const live = frames
            .slice(snapshotEnd + 1)
            .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
          expect(
            live.map((frame) => frame && decodeTerminalStreamText(frame.payload)).join('')
          ).toBe(soleOwner ? `${pending ? '\x18' : ''}\x1b[c${pending}${suffix}` : suffix)
          if (soleOwner) {
            expect(live[0]?.seq).toBe(0)
          }

          const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
          const replies: string[] = []
          terminal.onData((reply) => replies.push(reply))
          try {
            const seeded = new Promise<void>((resolve) => terminal.write(pending, resolve))
            await vi.runOnlyPendingTimersAsync()
            await seeded
            for (const frame of live) {
              if (frame) {
                const parsed = new Promise<void>((resolve) =>
                  terminal.write(decodeTerminalStreamText(frame.payload), resolve)
                )
                await vi.runOnlyPendingTimersAsync()
                await parsed
              }
            }
            expect(replies).toEqual(soleOwner ? ['\x1b[?1;2c'] : [])
            expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe('AFTER')
          } finally {
            terminal.dispose()
          }
        } finally {
          harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
          await harness.dispatchPromise
        }
        expect(answerYieldedTerminalQueries).not.toHaveBeenCalled()
      }
    )
  }
)

it.each([
  { queryCount: 2, action: 'pause' },
  { queryCount: 20, action: 'drain' },
  { queryCount: 200, action: 'drain' }
])(
  'preserves bounded query ownership for $queryCount transformed queries during $action',
  async ({ queryCount, action }) => {
    vi.useFakeTimers()
    let output: ((data: string, meta?: RuntimeTerminalDataMeta) => void) | undefined
    let completeSnapshot:
      | ((snapshot: { data: string; cols: number; rows: number; seq: number }) => void)
      | undefined
    let holdSnapshot = false
    const answerYieldedTerminalQueries = vi.fn()
    const harness = startDesktopMultiplexSubscribe({
      isSoleRemoteTerminalQueryOwner: () => true,
      answerYieldedTerminalQueries,
      serializeTerminalBuffer: vi.fn(async () => {
        if (!holdSnapshot) {
          return { data: '', cols: 80, rows: 24, seq: 0 }
        }
        return new Promise<{ data: string; cols: number; rows: number; seq: number }>((resolve) => {
          completeSnapshot = resolve
        })
      }),
      subscribeToTerminalData: vi.fn((_ptyId, listener) => {
        output = listener
        return vi.fn()
      })
    })
    const send = (opcode: TerminalStreamOpcode, payload: Record<string, unknown>): void => {
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
    }
    try {
      await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
      sendDesktopMultiplexSubscribe(harness.handlers, { ackOutput: 1, outputPause: 1 })
      await vi.waitFor(() =>
        expect(
          harness.messages.some((message) => JSON.parse(message).result?.type === 'subscribed')
        ).toBe(true)
      )
      const fill = 'x'.repeat(TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES - 3)
      output?.(fill, { seq: fill.length, rawLength: fill.length })
      await vi.runOnlyPendingTimersAsync()
      harness.binaryFrames.splice(0)
      holdSnapshot = true
      send(TerminalStreamOpcode.SnapshotRequest, {})
      await vi.waitFor(() => expect(completeSnapshot).toBeDefined())
      const rawLength = queryCount * 10
      const seq = fill.length + rawLength
      output?.('\x1b[c'.repeat(queryCount), { seq, rawLength, transformed: true })
      completeSnapshot?.({ data: '', cols: 80, rows: 24, seq })
      await vi.runOnlyPendingTimersAsync()
      if (action === 'pause') {
        send(TerminalStreamOpcode.SetOutputPaused, { paused: true })
      } else {
        send(TerminalStreamOpcode.Ack, { bytes: fill.length + 3 })
        await vi.runOnlyPendingTimersAsync()
      }
      const sentQueries = harness.binaryFrames
        .map(decodeTerminalStreamFrame)
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
        .map((frame) => frame && decodeTerminalStreamText(frame.payload))
        .join('')
      expect(sentQueries).toBe('\x1b[c'.repeat(action === 'pause' ? 1 : 16))
      if (action === 'pause') {
        expect(answerYieldedTerminalQueries).toHaveBeenCalledExactlyOnceWith('pty-1', '\x1b[c')
      } else {
        expect(answerYieldedTerminalQueries).not.toHaveBeenCalled()
      }
    } finally {
      harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
      await harness.dispatchPromise
    }
  }
)

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

it('replays DA1 trimmed from an overflowed ACK queue after the recovery snapshot', async () => {
  vi.useFakeTimers()
  const stream = await startSoleQueryOwnerStream()
  try {
    await stream.subscribe()
    await stream.waitSubscribed()
    await stream.emit('x'.repeat(TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES))
    await stream.emit('\x1b[c')
    await stream.emit('y'.repeat(TERMINAL_MULTIPLEX_PENDING_MAX_BYTES))
    stream.send(TerminalStreamOpcode.Ack, {
      bytes: TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES
    })
    await vi.runOnlyPendingTimersAsync()
    await vi.runOnlyPendingTimersAsync()

    expect(stream.outputAfterLastSnapshot()).toBe('\x1b[c')
    expect(stream.answerYieldedTerminalQueries).not.toHaveBeenCalled()
  } finally {
    await stream.cleanup()
  }
})

it('replays DA1 still batched when the ACK recovery snapshot covers it', async () => {
  vi.useFakeTimers()
  const stream = await startSoleQueryOwnerStream()
  try {
    await stream.subscribe()
    await stream.waitSubscribed()
    await stream.emit('x'.repeat(TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES))
    await stream.emit('y'.repeat(TERMINAL_MULTIPLEX_PENDING_MAX_BYTES + 1))
    stream.holdNextSnapshot()
    stream.send(TerminalStreamOpcode.Ack, {
      bytes: TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES
    })
    const release = await stream.held()
    await stream.emit('\x1b[c', { holdInBatcher: true })
    const snapshotSeq = stream.currentSeq()
    const snapshotEnds = stream.snapshotEndCount()
    release()
    // Publish recovery before the batcher's flush timer fires.
    for (let turn = 0; turn < 50 && stream.snapshotEndCount() === snapshotEnds; turn += 1) {
      await Promise.resolve()
    }
    expect(stream.snapshotEndCount()).toBe(snapshotEnds + 1)
    await vi.runOnlyPendingTimersAsync()

    expect(stream.outputAfterLastSnapshot(snapshotSeq)).toBe('\x1b[c')
    expect(stream.answerYieldedTerminalQueries).not.toHaveBeenCalled()
  } finally {
    await stream.cleanup()
  }
})

it.each(['initial', 'requested'] as const)(
  'replays DA1 discarded when %s snapshot buffering overflows',
  async (kind) => {
    vi.useFakeTimers()
    const stream = await startSoleQueryOwnerStream()
    try {
      if (kind === 'initial') {
        stream.holdNextSnapshot()
        await stream.subscribe()
      } else {
        await stream.subscribe()
        await stream.waitSubscribed()
        stream.holdNextSnapshot()
        stream.send(TerminalStreamOpcode.SnapshotRequest, {})
      }
      const release = await stream.held()
      await stream.emit('\x1b[c')
      await stream.emit('y'.repeat(TERMINAL_MULTIPLEX_PENDING_MAX_BYTES))
      release()
      await vi.runOnlyPendingTimersAsync()
      await vi.runOnlyPendingTimersAsync()

      expect(stream.outputAfterLastSnapshot()).toBe('\x1b[c')
      expect(stream.answerYieldedTerminalQueries).not.toHaveBeenCalled()
    } finally {
      await stream.cleanup()
    }
  }
)

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
