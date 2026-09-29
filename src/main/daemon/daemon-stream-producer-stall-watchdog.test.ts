import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import {
  SessionProducerPause,
  STREAM_BACKPRESSURE_STALL_WATCHDOG_MS
} from './session-producer-pause'

const MiB = 1024 * 1024
const CHUNK = 'x'.repeat(64 * 1024)

/** A stream socket whose peer accepts nothing until drain() is called — the half-open link that
 *  neither drains nor closes. */
function createStallableSocket() {
  const written: string[] = []
  const completions: (() => void)[] = []
  let buffered = 0
  const socket = {
    destroyed: false,
    get writableLength(): number {
      return buffered
    },
    write(line: string, complete?: () => void): boolean {
      written.push(line)
      buffered += Buffer.byteLength(line)
      if (complete) {
        completions.push(complete)
      }
      return false
    }
  }
  const drain = (): void => {
    buffered = 0
    for (const complete of completions.splice(0)) {
      complete()
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the batcher only uses write/writableLength/destroyed, all implemented above.
  return { socket: socket as unknown as Socket, written, drain }
}

function droppedChars(written: readonly string[]): number {
  return written.reduce((total, line) => {
    const message: { event?: string; payload?: { droppedChars?: number } } = JSON.parse(line)
    return message.event === 'dataGap' ? total + (message.payload?.droppedChars ?? 0) : total
  }, 0)
}

function createWiring() {
  const { socket, written, drain } = createStallableSocket()
  const subprocess = { pause: vi.fn(), resume: vi.fn() }
  const producer = new SessionProducerPause(subprocess)
  const batcher = new DaemonStreamDataBatcher(() => ({ streamSocket: socket }), {
    // Mirrors DaemonServer's wiring onto TerminalHost.
    onProducerBackpressureChanged: (_sessionId, paused, onStallTimeout) => {
      if (paused) {
        producer.pause('stream', true, onStallTimeout)
      } else {
        producer.resumeClient('stream')
      }
    }
  })
  const produceUntilPaused = (): void => {
    let produced = 0
    while (subprocess.pause.mock.calls.length === 0 && produced < 8 * MiB) {
      batcher.enqueue('client', 'flood', CHUNK)
      batcher.flush('client')
      produced += CHUNK.length
    }
    expect(subprocess.pause).toHaveBeenCalledOnce()
  }
  const drainFully = (advanceMsPerPass = 0): void => {
    for (let pass = 0; pass < 200 && batcher.queuedCharsForClient('client') > 0; pass++) {
      vi.advanceTimersByTime(advanceMsPerPass)
      drain()
      batcher.flush('client')
    }
    // Settle the last writes: the session stays accounted until the kernel takes its in-flight bytes.
    drain()
    expect(batcher.queuedCharsForClient('client')).toBe(0)
  }
  return {
    batcher,
    drain,
    drainFully,
    produceUntilPaused,
    producer,
    subprocess,
    written
  }
}

describe('producer stall watchdog end to end', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('turns a wedged consumer into a data gap instead of a frozen shell', () => {
    vi.useFakeTimers()
    const { batcher, drain, produceUntilPaused, subprocess, written } = createWiring()
    produceUntilPaused()
    expect(droppedChars(written)).toBe(0)

    vi.advanceTimersByTime(STREAM_BACKPRESSURE_STALL_WATCHDOG_MS)
    expect(subprocess.resume).toHaveBeenCalledOnce()

    // The shell runs again; its output is now keep-tail thinned rather than queued without bound.
    for (let chunk = 0; chunk < 16; chunk++) {
      batcher.enqueue('client', 'flood', CHUNK)
      batcher.flush('client')
    }
    expect(subprocess.pause).toHaveBeenCalledOnce()
    expect(2 * batcher.queuedCharsForClient('client')).toBeLessThan(4 * MiB)

    // The gap rides the stream in byte order, so the client sees it as soon as the link recovers.
    drain()
    batcher.flush('client')
    expect(droppedChars(written)).toBeGreaterThan(0)
  })

  it('restores ordinary pausing once the consumer catches up', () => {
    vi.useFakeTimers()
    const { batcher, drainFully, produceUntilPaused, subprocess, written } = createWiring()
    produceUntilPaused()
    vi.advanceTimersByTime(STREAM_BACKPRESSURE_STALL_WATCHDOG_MS)
    drainFully()

    const gapBefore = droppedChars(written)
    let produced = 0
    while (subprocess.pause.mock.calls.length < 2 && produced < 8 * MiB) {
      batcher.enqueue('client', 'flood', CHUNK)
      batcher.flush('client')
      produced += CHUNK.length
    }
    expect(subprocess.pause).toHaveBeenCalledTimes(2)
    expect(droppedChars(written)).toBe(gapBefore)
  })

  it('does not fire against a consumer that is draining', () => {
    vi.useFakeTimers()
    const { drainFully, produceUntilPaused, subprocess, written } = createWiring()
    produceUntilPaused()

    // A real client drains multi-MB backlogs in well under a second; give it 10ms a pass.
    drainFully(10)
    expect(subprocess.resume).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(STREAM_BACKPRESSURE_STALL_WATCHDOG_MS * 2)
    expect(droppedChars(written)).toBe(0)
    expect(subprocess.pause).toHaveBeenCalledOnce()
  })

  it('clears the watchdog when the stream socket closes', () => {
    vi.useFakeTimers()
    const { batcher, produceUntilPaused, subprocess, written } = createWiring()
    produceUntilPaused()

    // What onStreamDisconnected does once keepalive probes fail and the peer's socket closes.
    batcher.clear('client')
    expect(subprocess.resume).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(STREAM_BACKPRESSURE_STALL_WATCHDOG_MS * 2)
    expect(droppedChars(written)).toBe(0)
    expect(subprocess.pause).toHaveBeenCalledOnce()
  })
})
