import { describe, expect, it } from 'vitest'
import { BRIDGE_MAX_MESSAGE_BYTES } from './bridge/bridge-caps'
import { readBridgeHostMessage, type BridgeHostMessage } from './bridge/bridge-envelope'
import {
  BRIDGE_ACK_INTERVAL_BYTES,
  BRIDGE_ACK_INTERVAL_FRAMES
} from './bridge/bridge-client-subscriptions'
import { clientFrame, createFakeRpcClient } from './bridge-host-test-fakes'
import { harness, ID, OTHER } from './bridge-host-test-harness'
import { TERMINAL_STREAM_MAX_PENDING_BYTES } from './bridge-terminal-output-backlog'
import { mobileTerminalSnapshotByteBudget } from '../session/terminal-snapshot-byte-budget.web'
import type { TerminalBacklogTimers } from './bridge-terminal-output-backlog'

// Rebuild measured terminal timing: host JSON at 70.3 MiB/s, xterm at 2.2 MiB/s, batcher 64 KiB/5 ms and chunker 48 KiB; a 5 MB cat exhausts the ordinary window before paint.
// Measure JSON expansion for ASCII and SGR output; simulate the timeline because the original design capture files are not in this lane.

const TERMINAL_STREAM_CHUNK_BYTES = 48 * 1024

const PAGE_DRAIN_BYTES_PER_SECOND = 2.2 * 1024 * 1024

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
  delivered: string[]
  largestFrameBytes: number
  frames: number
  ended: boolean
}

// Simulate emit → limited page drain → interval acknowledgement at measured rates; this ordering determines whether backpressure kills the stream.
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

  const events: { frame: BridgeHostMessage; bytes: number }[] = []
  let postedCursor = 0
  let largestFrameBytes = 0
  let ended = false

  const readPosted = (): void => {
    for (const json of bridge.posted.slice(postedCursor)) {
      const read = readBridgeHostMessage(json)
      if (!read.ok) {
        throw new Error(`the page would refuse this frame: ${read.refusal}`)
      }
      postedCursor += 1
      const frame = read.message
      const bytes = JSON.stringify(frame).length
      largestFrameBytes = Math.max(largestFrameBytes, bytes)
      if (frame.type === 'event' && frame.id === ID) {
        events.push({ frame, bytes })
      }
      if (frame.type === 'end' && frame.id === ID) {
        ended = true
      }
    }
  }

  const readOne = (): boolean => {
    readPosted()
    const event = events[readFrames]
    if (event === undefined) {
      return false
    }
    const { frame, bytes } = event
    if (frame.type !== 'event') {
      return false
    }
    readFrames += 1
    lastReadSeq = frame.seq
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
    unreadBytes += bytes
    if (unreadFrames >= BRIDGE_ACK_INTERVAL_FRAMES || unreadBytes >= BRIDGE_ACK_INTERVAL_BYTES) {
      unreadFrames = 0
      unreadBytes = 0
      bridge.host.receive(clientFrame({ type: 'ack', id: ID, seq: lastReadSeq }))
    }
    return true
  }

  for (const chunk of chunks) {
    stream.emit({ type: 'data', streamId: 1, chunk })
    // Allow about 5 ms of drain per batcher chunk, matching its 64 KiB/5 ms flush.
    drainCreditBytes += (PAGE_DRAIN_BYTES_PER_SECOND * 5) / 1000
    while (drainCreditBytes > 0 && readOne()) {}
  }
  // Catch up using only normal interval acknowledgements; acking every frame would hide a stale timer after the queue empties.
  while (readOne()) {}
  readPosted()
  return {
    delivered,
    largestFrameBytes,
    frames: events.length,
    ended
  }
}

describe.each([
  ['a plain 5 MB cat', transcript(plainChunk)],
  ['grep --color over the same file', transcript(colouredChunk)]
])('%s, against a page draining at 2.2 MiB/s', (_label, chunks) => {
  it('is what the byte window kills, which is the defect', () => {
    // Use the same timeline on a nonterminal control stream to prove survival comes from the hold rule.
    const other = replay(chunks, { method: 'session.tabs.subscribe' })
    expect(other.ended).toBe(true)
    expect(other.delivered.length).toBeLessThan(chunks.length)
  })

  it('lives, with every byte delivered in order', () => {
    const run = replay(chunks)
    expect(run.ended).toBe(false)
    expect(run.delivered.join('')).toBe(chunks.join(''))
    expect(run.frames).toBeLessThan(chunks.length)
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
    const report = reports[0]
    if (report?.kind !== 'terminal-backlog') {
      throw new Error('backlog report missing')
    }
    expect(report.peakPendingBytes).toBeGreaterThan(TERMINAL_STREAM_MAX_PENDING_BYTES)
  })

  it('still ends on one event over the frame cap, which is C0.3 and is not slowness', () => {
    // Holding cannot rescue an event the page refuses for size; the frame cap still ends it visibly.
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
  // After the final delivery, clear the silence timer; an idle terminal owes no further ack and must not die twenty seconds later.
  it('does not die on the silence bound once its queue is empty', () => {
    const timers = manualTimers()
    const bridge = harness({ ready: true, terminalTimers: timers })
    bridge.host.receive(
      clientFrame({ type: 'subscribe', id: ID, method: 'terminal.subscribe', params: {} })
    )
    const stream = bridge.client.streams[0]
    const chunk = 'x'.repeat(1024)
    const emitted = 300
    for (let index = 0; index < emitted; index += 1) {
      stream.emit({ type: 'data', streamId: 1, chunk })
    }
    expect(timers.armed()).toBe(true)

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

    // Stop acknowledgements after the final delivered frame; an extra ack would accidentally clear the stale timer this case must expose.
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

  // Close the frame-count window cheaply; 256 small frames exercise the same held state without allocating a 4 MiB byte-window fixture.
  const SMALL_CHUNK = 'x'.repeat(1024)
  const OVER_FRAME_WINDOW = 300

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
    // Merge only consecutive output; resize/metadata must retain their position between byte runs.
    const bridge = subscribed([ID])
    for (let index = 0; index < OVER_FRAME_WINDOW; index += 1) {
      bridge.client.streams[0].emit({ type: 'data', streamId: 1, chunk: SMALL_CHUNK })
    }
    bridge.client.streams[0].emit({ type: 'resized', streamId: 1, cols: 80, rows: 24 })
    bridge.client.streams[0].emit({ type: 'data', streamId: 1, chunk: 'after-the-resize' })
    drain(bridge, ID)
    const payloads = bridge
      .frames()
      .flatMap((frame) => (frame.type === 'event' && 'payload' in frame ? [frame.payload] : []))
    const resizeAt = payloads.findIndex(
      (payload) =>
        typeof payload === 'object' &&
        payload !== null &&
        'type' in payload &&
        payload.type === 'resized'
    )
    expect(resizeAt).toBeGreaterThan(0)
    expect(payloads[resizeAt]).toEqual({ type: 'resized', streamId: 1, cols: 80, rows: 24 })
    const before = payloads
      .slice(0, resizeAt)
      .map((payload) => {
        if (typeof payload !== 'object' || payload === null || !('chunk' in payload)) {
          throw new Error('missing pre-resize output')
        }
        return payload.chunk
      })
      .join('')
    expect(before).toBe(SMALL_CHUNK.repeat(OVER_FRAME_WINDOW))
    expect(payloads.slice(resizeAt + 1)).toEqual([
      { type: 'data', streamId: 1, chunk: 'after-the-resize' }
    ])
    expect(bridge.frames().some((frame) => frame.type === 'end')).toBe(false)
  })
})

// Test the enforced half of the desktop snapshot budget: a serialized payload at budget crosses, and one over frame cap is refused.
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
    const bytes = new TextEncoder().encode(bridge.posted.at(-1)).byteLength
    expect(bytes).toBeLessThanOrEqual(BRIDGE_MAX_MESSAGE_BYTES)
    expect(BRIDGE_MAX_MESSAGE_BYTES - bytes).toBeLessThan(64)
  })

  it('ends the stream on a payload the cap cannot hold, which is why the host trims', () => {
    // A host-budgeted snapshot must never reach this refusal; the page cannot detect a silently omitted event (C0.3).
    const bridge = post(BRIDGE_MAX_MESSAGE_BYTES)
    expect(bridge.frames().filter((frame) => frame.type === 'end')).toEqual([
      { v: 1, type: 'end', id: ID, reason: 'overflow' }
    ])
  })
})
