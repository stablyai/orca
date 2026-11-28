import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonStreamBackpressure } from './daemon-stream-backpressure'
import { SessionProducerPause } from '../../sessions/session-producer-pause'

type StallHandler = (reason: 'input' | 'timeout') => void

function recordingBackpressure(): {
  backpressure: DaemonStreamBackpressure
  paused: Map<string, boolean>
  stall: () => StallHandler | undefined
} {
  const paused = new Map<string, boolean>()
  let stall: StallHandler | undefined
  const backpressure = new DaemonStreamBackpressure(
    (sessionId, isPaused, onStall) => {
      paused.set(sessionId, isPaused)
      stall = onStall ?? stall
    },
    () => false
  )
  return { backpressure, paused, stall: () => stall }
}

describe('DaemonStreamBackpressure', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('pauses a flooding session on its own backlog and never pauses its quiet sibling', () => {
    const { backpressure, paused } = recordingBackpressure()
    // 400 KB of held output is far below the 4 MB global cap.
    backpressure.setQueued(
      'client',
      new Map([
        ['flood', 200 * 1024],
        ['tui', 1024]
      ])
    )
    expect(paused.get('flood')).toBe(true)
    expect(paused.has('tui')).toBe(false)

    backpressure.setQueued(
      'client',
      new Map([
        ['flood', 32 * 1024],
        ['tui', 1024]
      ])
    )
    expect(paused.get('flood')).toBe(false)
  })

  it('sheds a stalled consumer at 60 s even while the user keeps typing', () => {
    vi.useFakeTimers()
    const subprocess = { pause: vi.fn(), resume: vi.fn() }
    const producer = new SessionProducerPause(subprocess)
    const backpressure = new DaemonStreamBackpressure(
      (_sessionId, isPaused, onStall) =>
        isPaused ? producer.pause('stream', true, onStall) : producer.resumeClient('stream'),
      () => false
    )
    backpressure.setQueued('client', new Map([['tui', 200 * 1024]]))
    expect(subprocess.pause).toHaveBeenCalledTimes(1)

    for (let second = 0; second < 59; second++) {
      producer.noteInput('a')
      vi.advanceTimersByTime(1_000)
    }
    expect(subprocess.resume).not.toHaveBeenCalled()
    expect(backpressure.isStallReleased('tui')).toBe(false)

    vi.advanceTimersByTime(1_500)
    expect(backpressure.isStallReleased('tui')).toBe(true)
    expect(subprocess.resume).toHaveBeenCalledTimes(1)
  })

  it('treats a client with no completed write as stalled, even one just created', () => {
    const { backpressure, stall } = recordingBackpressure()
    backpressure.setQueued('client', new Map([['tui', 200 * 1024]]))
    stall()?.('timeout')
    expect(backpressure.isStallReleased('tui')).toBe(true)
  })

  it('resumes a draining consumer on typed input without shedding', async () => {
    const { backpressure, paused, stall } = recordingBackpressure()
    const socket = new PassThrough()
    socket.resume()
    backpressure.write('client', 'tui', socket, 'x')
    await new Promise((resolve) => setImmediate(resolve))
    backpressure.setQueued('client', new Map([['tui', 200 * 1024]]))
    expect(paused.get('tui')).toBe(true)

    stall()?.('input')
    expect(paused.get('tui')).toBe(false)
    expect(backpressure.isStallReleased('tui')).toBe(false)
  })
})
