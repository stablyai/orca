import { describe, expect, it } from 'vitest'
import { BRIDGE_MAX_MESSAGE_BYTES } from './bridge/bridge-caps'
import {
  BRIDGE_ACK_INTERVAL_BYTES,
  BRIDGE_ACK_INTERVAL_FRAMES
} from './bridge/bridge-client-subscriptions'
import { clientFrame, createFakeRpcClient } from './bridge-host-test-fakes'
import { harness, ID, OTHER } from './bridge-host-test-harness'
import { TERMINAL_STREAM_MAX_PENDING_BYTES } from './bridge-terminal-output-backlog'
import { mobileTerminalSnapshotByteBudget } from '../session/terminal-snapshot-byte-budget.web'
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
    // A binary event carries no `payload` at all, so the arm is narrowed rather than reached into.
    const payload = 'payload' in frame ? frame.payload : null
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
  // Then it catches up with no producer in front of it. No ack beyond the ones `readOne` already
  // sends: acking every frame here was the page behaving better than a page can, and it hid a
  // backlog left armed after its queue emptied.
  while (readOne()) {
    // The page reads; the interval acks inside `readOne` are the only ones it sends.
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

describe('a held terminal stream that has caught up', () => {
  /**
   * The invariant the first round broke: armed must mean waiting on the page.
   *
   * An ack re-armed the clock and the drain that followed emptied the queue without clearing it, so
   * a terminal that had delivered every byte and gone quiet — which is what a terminal does between
   * commands — died on `overflow` twenty seconds later. The suite could not see it because its
   * replay acked every frame in the catch-up loop, which no page does.
   */
  it('does not die on the silence bound once its queue is empty', () => {
    const timers = manualTimers()
    const bridge = harness({ ready: true, terminalTimers: timers })
    bridge.host.receive(
      clientFrame({ type: 'subscribe', id: ID, method: 'terminal.subscribe', params: {} })
    )
    const stream = bridge.client.streams[0]
    const chunk = 'x'.repeat(1024)
    const emitted = 300
    // Past the frame window, so output is held and the clock is armed.
    for (let index = 0; index < emitted; index += 1) {
      stream.emit({ type: 'data', streamId: 1, chunk })
    }
    expect(timers.armed()).toBe(true)

    /** Every byte the page has been handed, which is how it knows it has caught up. */
    const deliveredBytes = (): number =>
      bridge
        .frames()
        .filter((frame) => frame.type === 'event' && frame.id === ID)
        .reduce((total, frame) => {
          const payload = 'payload' in frame ? frame.payload : null
          return payload !== null &&
            typeof payload === 'object' &&
            'chunk' in payload &&
            typeof payload.chunk === 'string'
            ? total + payload.chunk.length
            : total
        }, 0)

    // Acks stop at the one that completes delivery. A page sends no ack after that: it acks on
    // reading frames, and there are no more frames to read. Acking once more is what hid this —
    // that extra ack finds an empty queue and clears the clock by accident.
    const total = emitted * chunk.length
    for (let pass = 0; pass < 2_000 && deliveredBytes() < total; pass += 1) {
      const events = bridge.frames().filter((frame) => frame.type === 'event' && frame.id === ID)
      const last = events.at(-1)
      if (last === undefined || last.type !== 'event') {
        break
      }
      bridge.host.receive(clientFrame({ type: 'ack', id: ID, seq: last.seq }))
    }
    expect(deliveredBytes()).toBe(total)

    // An idle terminal: nothing pending, nothing owed, and no clock that could end it.
    expect(timers.armed()).toBe(false)
    timers.fire()
    expect(bridge.frames().some((frame) => frame.type === 'end')).toBe(false)
  })
})

describe('the cases the rulings name', () => {
  function subscribed(
    ids: readonly string[]
  ): ReturnType<typeof harness> & { timers: ReturnType<typeof manualTimers> } {
    const timers = manualTimers()
    const bridge = harness({ ready: true, terminalTimers: timers })
    for (const id of ids) {
      bridge.host.receive(
        clientFrame({ type: 'subscribe', id, method: 'terminal.subscribe', params: {} })
      )
    }
    return Object.assign(bridge, { timers })
  }

  /**
   * Enough frames to close the window on its frame count rather than its byte count.
   *
   * The two limits are the same state to this module and one of them is 4 MiB of string work per
   * case. `BRIDGE_MAX_UNACKED_FRAMES` is 256, so this closes it with a few hundred kilobytes.
   */
  const SMALL_CHUNK = 'x'.repeat(1024)
  const OVER_FRAME_WINDOW = 300

  /** The page reading and acking until the shell has nothing left to hand it. */
  function drain(bridge: ReturnType<typeof harness>, id: string): void {
    for (let pass = 0; pass < 2_000; pass += 1) {
      const events = bridge.frames().filter((frame) => frame.type === 'event' && frame.id === id)
      const last = events.at(-1)
      if (last === undefined || last.type !== 'event') {
        return
      }
      const before = bridge.frames().length
      bridge.host.receive(clientFrame({ type: 'ack', id, seq: last.seq }))
      if (bridge.frames().length === before) {
        return
      }
    }
  }

  it('keeps one backlog per subscription, so a busy terminal cannot end a quiet one', () => {
    const bridge = subscribed([ID, OTHER])
    for (let index = 0; index < OVER_FRAME_WINDOW; index += 1) {
      bridge.client.streams[0].emit({ type: 'data', streamId: 1, chunk: SMALL_CHUNK })
    }
    bridge.client.streams[1].emit({ type: 'data', streamId: 2, chunk: 'quiet' })
    // The second stream is nowhere near its own window, so its one frame went out at once.
    const other = bridge.frames().filter((frame) => frame.type === 'event' && frame.id === OTHER)
    expect(other).toHaveLength(1)
    expect(bridge.frames().some((frame) => frame.type === 'end' && frame.id === OTHER)).toBe(false)
  })

  it('posts nothing for a stream the page unsubscribed while its backlog was full', () => {
    const bridge = subscribed([ID])
    for (let index = 0; index < OVER_FRAME_WINDOW; index += 1) {
      bridge.client.streams[0].emit({ type: 'data', streamId: 1, chunk: SMALL_CHUNK })
    }
    bridge.host.receive(clientFrame({ type: 'cancel', id: ID, target: 'subscription' }))
    const after = bridge.frames().length
    // Whatever the desktop keeps sending, and whatever the page acks, is now nobody's.
    bridge.client.streams[0].emit({ type: 'data', streamId: 1, chunk: SMALL_CHUNK })
    bridge.host.receive(clientFrame({ type: 'ack', id: ID, seq: 1 }))
    expect(bridge.frames()).toHaveLength(after)
    expect(bridge.timers.armed()).toBe(false)
  })

  it('posts nothing after an end, however much was still held', () => {
    const bridge = subscribed([ID])
    for (let index = 0; index < OVER_FRAME_WINDOW; index += 1) {
      bridge.client.streams[0].emit({ type: 'data', streamId: 1, chunk: SMALL_CHUNK })
    }
    bridge.timers.fire()
    const ends = bridge.frames().filter((frame) => frame.type === 'end')
    expect(ends).toHaveLength(1)
    const after = bridge.frames().length
    bridge.host.receive(clientFrame({ type: 'ack', id: ID, seq: 1 }))
    bridge.client.streams[0].emit({ type: 'data', streamId: 1, chunk: 'more' })
    expect(bridge.frames()).toHaveLength(after)
  })

  it('breaks a merge run on a payload that is not output, and keeps the order', () => {
    // A resize or a metadata frame is state the reader applies in place; concatenating across one
    // would deliver bytes it should have applied after. The run stops at it and resumes behind it.
    const bridge = subscribed([ID])
    for (let index = 0; index < OVER_FRAME_WINDOW; index += 1) {
      bridge.client.streams[0].emit({ type: 'data', streamId: 1, chunk: SMALL_CHUNK })
    }
    bridge.client.streams[0].emit({ type: 'resized', streamId: 1, cols: 80, rows: 24 })
    bridge.client.streams[0].emit({ type: 'data', streamId: 1, chunk: 'after-the-resize' })
    drain(bridge, ID)
    const kinds = bridge
      .frames()
      .filter((frame) => frame.type === 'event' && frame.id === ID)
      .map((frame) =>
        frame.type === 'event' &&
        'payload' in frame &&
        frame.payload !== null &&
        typeof frame.payload === 'object' &&
        'type' in frame.payload
          ? frame.payload.type
          : null
      )
    const resizeAt = kinds.indexOf('resized')
    expect(resizeAt).toBeGreaterThan(0)
    // The resize is its own frame, and the chunk behind it is behind it.
    expect(kinds.slice(resizeAt + 1)).toContain('data')
    expect(bridge.frames().some((frame) => frame.type === 'end')).toBe(false)
  })
})

/**
 * The boundary the desktop's snapshot budget is sized against, checked on the side that enforces it.
 *
 * The page asks the host for a snapshot no larger than this, and the host trims against it by
 * building the payload it will publish. Here is the other half of that contract: a payload that
 * serializes to exactly the budget crosses, and one byte more does not. Without this the budget is
 * a number two files agree on and nothing tests.
 */
describe('a snapshot payload at the budget the page asks for', () => {
  function scrollbackPayload(payloadBytes: number): unknown {
    const skeleton = JSON.stringify({ type: 'scrollback', streamId: 1, serialized: '' }).length
    return { type: 'scrollback', streamId: 1, serialized: 'x'.repeat(payloadBytes - skeleton) }
  }

  function post(payloadBytes: number): ReturnType<typeof harness> {
    const bridge = harness({ ready: true, terminalTimers: manualTimers() })
    bridge.host.receive(
      clientFrame({ type: 'subscribe', id: ID, method: 'terminal.subscribe', params: {} })
    )
    const payload = scrollbackPayload(payloadBytes)
    expect(JSON.stringify(payload)).toHaveLength(payloadBytes)
    bridge.client.streams[0].emit(payload)
    return bridge
  }

  it('is delivered, and the frame it makes is inside the cap', () => {
    const bridge = post(mobileTerminalSnapshotByteBudget() ?? 0)
    const events = bridge.frames().filter((frame) => frame.type === 'event' && frame.id === ID)
    expect(events).toHaveLength(1)
    expect(bridge.frames().some((frame) => frame.type === 'end')).toBe(false)
    expect(bridge.posted[bridge.posted.length - 1].length).toBeLessThanOrEqual(
      BRIDGE_MAX_MESSAGE_BYTES
    )
  })

  /**
   * The budget is a bound, and a bound with slack in it is doing its job.
   *
   * It is computed at the widest every envelope field can be written — a full-length id and `seq`
   * at the largest integer it can hold — so a real first frame, whose `seq` is 1, has room to
   * spare. Asserted as a direction rather than as a number: what must never happen is the budget
   * leaving too little, and the amount it leaves over is the seq counter's width.
   */
  it('leaves the frame inside the cap with room, rather than exactly at it', () => {
    const bridge = post(mobileTerminalSnapshotByteBudget() ?? 0)
    const frame = bridge.posted[bridge.posted.length - 1]
    expect(frame.length).toBeLessThanOrEqual(BRIDGE_MAX_MESSAGE_BYTES)
    expect(BRIDGE_MAX_MESSAGE_BYTES - frame.length).toBeLessThan(64)
  })

  it('ends the stream on a payload the cap cannot hold, which is why the host trims', () => {
    // C0.3 stands: an event the page's own reader would refuse leaves a hole its reader cannot
    // see. The budget exists so this arm is never reached by a snapshot the host chose to send.
    const bridge = post(BRIDGE_MAX_MESSAGE_BYTES)
    expect(bridge.frames().filter((frame) => frame.type === 'end')).toEqual([
      { v: 1, type: 'end', id: ID, reason: 'overflow' }
    ])
  })
})
