import { describe, expect, it } from 'vitest'
import { BRIDGE_MAX_MESSAGE_BYTES } from './bridge/bridge-caps'
import {
  BRIDGE_ACK_INTERVAL_BYTES,
  BRIDGE_ACK_INTERVAL_FRAMES
} from './bridge/bridge-client-subscriptions'
import { clientFrame, createFakeRpcClient } from './bridge-host-test-fakes'
import { harness, ID } from './bridge-host-test-harness'
import { TERMINAL_STREAM_MAX_PENDING_BYTES } from './bridge-terminal-output-backlog'
import type { TerminalBacklogTimers } from './bridge-terminal-output-backlog'

/**
 * A terminal stream against a page that reads slower than the host writes, which is every terminal.
 *
 * The byte window ends a stream when the page falls 4 MiB behind. For a terminal that is not a page
 * that went wrong: C7's design measured the host producing 70.3 MiB/s of JSON while real xterm in a
 * browser applies 2.2 MiB/s, so an ordinary 5 MB `cat` crosses the window in 62 ms and the pane
 * dies before it has painted anything.
 *
 * The timelines below are rebuilt from that design's measured parameters rather than replayed from
 * its capture files, which this lane does not carry: the host's batcher flushes at 64 KiB or 5 ms
 * and `iterateTerminalOutputFrameChunks` splits at 48 KiB, so the frame sizes are the ones those
 * two rules produce, and the JSON expansion is measured here on the bytes rather than assumed —
 * plain output escapes little, and `grep --color` is SGR sequences whose ESC bytes cost six each.
 */

/** The chunker's split, which is what bounds one output payload before any of this runs. */
const TERMINAL_STREAM_CHUNK_BYTES = 48 * 1024

/** What the page applies per second, measured by the design against real xterm with WebGL. */
const PAGE_DRAIN_BYTES_PER_SECOND = 2.2 * 1024 * 1024

/** A 5 MB transcript, which is the `cat` the design ran. */
const TRANSCRIPT_BYTES = 5 * 1024 * 1024

function plainChunk(index: number): string {
  // Ordinary program output: printable ASCII, so JSON costs it almost nothing.
  return `${String(index).padStart(6, '0')} `.repeat(Math.floor(TERMINAL_STREAM_CHUNK_BYTES / 7))
}

function colouredChunk(index: number): string {
  // `grep --color`: an SGR pair around every match, and every ESC costs six bytes as JSON.
  const cell = `\u001b[01;31m\u001b[K${index % 10}\u001b[m\u001b[K`
  return cell.repeat(Math.floor(TERMINAL_STREAM_CHUNK_BYTES / cell.length))
}

function transcript(chunkOf: (index: number) => string): string[] {
  const chunks: string[] = []
  let bytes = 0
  for (let index = 0; bytes < TRANSCRIPT_BYTES; index += 1) {
    const chunk = chunkOf(index)
    chunks.push(chunk)
    bytes += chunk.length
  }
  return chunks
}

/** A clock a case drives, so the twenty-second silence bound costs a test nothing to reach. */
function manualTimers(): TerminalBacklogTimers & { fire: () => void; armed: () => boolean } {
  let handler: (() => void) | null = null
  return {
    set: (next) => {
      handler = next
      return 1
    },
    clear: () => {
      handler = null
    },
    armed: () => handler !== null,
    fire: () => {
      const pending = handler
      handler = null
      pending?.()
    }
  }
}

type Replay = {
  /** Every chunk the page's listener was handed, in the order it was handed them. */
  delivered: string[]
  /** The largest event frame the shell posted, which must never be over the cap. */
  largestFrameBytes: number
  /** Frames the page had to read, against the chunks the host produced. */
  frames: number
  ended: boolean
}

/**
 * One transcript through the real ledger, against a page that acks on the real intervals.
 *
 * Time is simulated rather than waited on: the page is credited with drain time between emits at
 * the rate measured above, and acks whenever it has read a full interval's worth. That is the same
 * order a device runs in — the shell emits, the page reads, the page acks — and it is what decides
 * whether the window was ever the thing that ended the stream.
 */
function replay(chunks: readonly string[], options: { method?: string } = {}): Replay {
  const client = createFakeRpcClient()
  const timers = manualTimers()
  const bridge = harness({ client, ready: true, terminalTimers: timers })
  bridge.host.receive(
    clientFrame({
      type: 'subscribe',
      id: ID,
      method: options.method ?? 'terminal.subscribe',
      params: { terminal: 't' }
    })
  )
  const stream = client.streams[0]
  const delivered: string[] = []
  let readFrames = 0
  let lastReadSeq = 0
  let unreadFrames = 0
  let unreadBytes = 0
  let drainCreditBytes = 0

  /** One frame off the page's queue, or false when it has caught up. This is the drain. */
  const readOne = (): boolean => {
    const events = bridge.frames().filter((frame) => frame.type === 'event' && frame.id === ID)
    const frame = events[readFrames]
    if (frame === undefined || frame.type !== 'event') {
      return false
    }
    readFrames += 1
    lastReadSeq = frame.seq
    const payload = frame.payload
    let applied = 0
    if (payload !== null && typeof payload === 'object' && 'chunk' in payload) {
      const chunk = payload.chunk
      if (typeof chunk === 'string') {
        delivered.push(chunk)
        applied = chunk.length
      }
    }
    drainCreditBytes -= applied
    unreadFrames += 1
    unreadBytes += JSON.stringify(frame).length
    if (unreadFrames >= BRIDGE_ACK_INTERVAL_FRAMES || unreadBytes >= BRIDGE_ACK_INTERVAL_BYTES) {
      unreadFrames = 0
      unreadBytes = 0
      bridge.host.receive(clientFrame({ type: 'ack', id: ID, seq: lastReadSeq }))
    }
    return true
  }

  for (const chunk of chunks) {
    stream.emit({ type: 'data', streamId: 1, chunk })
    // The host's batcher flushes at 64 KiB or 5 ms, so one chunk is about 5 ms of wall clock and
    // the page has that long to apply what it can.
    drainCreditBytes += (PAGE_DRAIN_BYTES_PER_SECOND * 5) / 1000
    while (drainCreditBytes > 0 && readOne()) {
      // The page reads until its time is spent, which is what makes it 31x slower than the host.
    }
  }
  // Then it catches up with no producer in front of it, acking as it goes.
  while (readOne()) {
    bridge.host.receive(clientFrame({ type: 'ack', id: ID, seq: lastReadSeq }))
  }
  const events = bridge.frames().filter((frame) => frame.type === 'event' && frame.id === ID)
  return {
    delivered,
    largestFrameBytes: Math.max(0, ...bridge.frames().map((frame) => JSON.stringify(frame).length)),
    frames: events.length,
    ended: bridge.frames().some((frame) => frame.type === 'end' && frame.id === ID)
  }
}

describe.each([
  ['a plain 5 MB cat', transcript(plainChunk)],
  ['grep --color over the same file', transcript(colouredChunk)]
])('%s, against a page draining at 2.2 MiB/s', (_label, chunks) => {
  it('is what the byte window kills, which is the defect', () => {
    // The control, on a stream the hold rule is not keyed to: same timeline, same page, same
    // window. Without this an assertion that the terminal survives says nothing about why.
    const other = replay(chunks, { method: 'session.tabs.subscribe' })
    expect(other.ended).toBe(true)
    expect(other.delivered.length).toBeLessThan(chunks.length)
  })

  it('lives, with every byte delivered in order', () => {
    const run = replay(chunks)
    expect(run.ended).toBe(false)
    expect(run.delivered.join('')).toBe(chunks.join(''))
  })

  it('delivers it in fewer frames than it was produced in', () => {
    const run = replay(chunks)
    expect(run.frames).toBeLessThan(chunks.length)
  })

  it('never posts a frame over the cap, however much it merged', () => {
    const run = replay(chunks)
    expect(run.largestFrameBytes).toBeLessThanOrEqual(BRIDGE_MAX_MESSAGE_BYTES)
  })
})

describe('the two ends a held terminal stream has', () => {
  function held(): ReturnType<typeof harness> & { timers: ReturnType<typeof manualTimers> } {
    const timers = manualTimers()
    const bridge = harness({ ready: true, terminalTimers: timers })
    bridge.host.receive(
      clientFrame({ type: 'subscribe', id: ID, method: 'terminal.subscribe', params: {} })
    )
    return Object.assign(bridge, { timers })
  }

  it('ends once when the page has acked nothing for the silence bound', () => {
    const bridge = held()
    const client = bridge.client
    const stream = client.streams[0]
    // Enough to close the window, so the stream starts holding and arms the clock.
    for (let index = 0; index < 200; index += 1) {
      stream.emit({ type: 'data', streamId: 1, chunk: 'x'.repeat(64 * 1024) })
    }
    expect(bridge.timers.armed()).toBe(true)
    expect(bridge.frames().some((frame) => frame.type === 'end')).toBe(false)
    bridge.timers.fire()
    const ends = bridge.frames().filter((frame) => frame.type === 'end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ reason: 'overflow' })
    const reports = bridge.diagnostics.filter((entry) => entry.kind === 'terminal-backlog')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ ended: 'ack-silence' })
  })

  it('ends once when the backlog passes the ceiling, and says how far it got', () => {
    const bridge = held()
    const stream = bridge.client.streams[0]
    const chunk = 'y'.repeat(512 * 1024)
    const chunks = Math.ceil(TERMINAL_STREAM_MAX_PENDING_BYTES / chunk.length) + 16
    for (let index = 0; index < chunks; index += 1) {
      stream.emit({ type: 'data', streamId: 1, chunk })
    }
    const ends = bridge.frames().filter((frame) => frame.type === 'end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ reason: 'overflow' })
    const reports = bridge.diagnostics.filter((entry) => entry.kind === 'terminal-backlog')
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ ended: 'pending-ceiling' })
    expect(reports[0]).toHaveProperty('peakPendingBytes')
  })

  it('still ends on one event over the frame cap, which is C0.3 and is not slowness', () => {
    // The rule that does not move: an event the page's own reader would refuse leaves a hole its
    // reader cannot see, and holding it would only postpone the same verdict.
    const bridge = held()
    bridge.client.streams[0].emit({
      type: 'data',
      streamId: 1,
      chunk: 'z'.repeat(BRIDGE_MAX_MESSAGE_BYTES + 1)
    })
    const ends = bridge.frames().filter((frame) => frame.type === 'end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ reason: 'overflow' })
  })
})
