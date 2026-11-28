import { Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonStreamBackpressure } from './daemon-stream-backpressure'
import { SessionProducerPause } from '../../sessions/session-producer-pause'

type StallHandler = (reason: 'input' | 'timeout' | 'released' | 'terminating' | 'exited') => void

function recordingBackpressure(options: { incarnationOf?: () => string } = {}): {
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
    () => false,
    undefined,
    options
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
    backpressure.setQueued('client', new Map([['tui', 200 * 1024]]))
    expect(paused.get('tui')).toBe(true)
    backpressure.write('client', 'tui', completingSocket(), 'x')
    await new Promise((resolve) => process.nextTick(resolve))

    stall()?.('input')
    expect(paused.get('tui')).toBe(false)
    expect(backpressure.isStallReleased('tui')).toBe(false)
  })

  it("sheds a held session at 60 s even while a sibling's writes keep completing", async () => {
    const { backpressure, stall } = recordingBackpressure()
    backpressure.setQueued('client', new Map([['tui', 200 * 1024]]))
    backpressure.write('client', 'echo', completingSocket(), 'x')
    await new Promise((resolve) => process.nextTick(resolve))

    stall()?.('timeout')
    expect(backpressure.isStallReleased('tui')).toBe(true)
  })

  it('pauses afresh after a detach released the pause, and still sheds at 60 s', () => {
    vi.useFakeTimers()
    const subprocess = { pause: vi.fn(), resume: vi.fn() }
    const producer = new SessionProducerPause(subprocess)
    const backpressure = new DaemonStreamBackpressure(
      (_sessionId, isPaused, onStall) =>
        isPaused ? producer.pause('stream', true, onStall) : producer.resumeClient('stream'),
      () => false
    )
    backpressure.setQueued('client', new Map([['tui', 200 * 1024]]))
    producer.release({ resume: true, reason: 'released' })
    expect(subprocess.resume).toHaveBeenCalledTimes(1)

    backpressure.setQueued('client', new Map([['tui', 201 * 1024]]))
    expect(subprocess.pause).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(60_500)
    expect(backpressure.isStallReleased('tui')).toBe(true)
  })

  it('a respawn under the same id starts clean after its predecessor exited while paused', () => {
    vi.useFakeTimers()
    let incarnation = 'first'
    const producers = new Map<string, SessionProducerPause>()
    const producer = (): SessionProducerPause => {
      const existing = producers.get(incarnation)
      if (existing) {
        return existing
      }
      const created = new SessionProducerPause({ pause: () => {}, resume: () => {} })
      producers.set(incarnation, created)
      return created
    }
    let pauseCalls = 0
    const backpressure = new DaemonStreamBackpressure(
      (_sessionId, isPaused, onStall) => {
        if (!isPaused) {
          producer().resumeClient('stream')
          return
        }
        pauseCalls += 1
        return producer().pause('stream', true, onStall)
      },
      () => false,
      undefined,
      { incarnationOf: () => incarnation }
    )
    backpressure.setQueued('client', new Map([['tui', 200 * 1024]]))
    producer().release({ resume: false, reason: 'exited' })

    incarnation = 'second'
    backpressure.noteSessionOutput('tui')
    backpressure.setQueued('client', new Map([['tui', 201 * 1024]]))
    expect(pauseCalls).toBe(2)
    vi.advanceTimersByTime(60_500)
    expect(backpressure.isStallReleased('tui')).toBe(true)
  })

  it('pauses a respawn whose id earlier answered exited', () => {
    let incarnation = 'gone'
    let pauseCalls = 0
    const backpressure = new DaemonStreamBackpressure(
      (_sessionId, isPaused) => {
        if (!isPaused) {
          return
        }
        pauseCalls += 1
        return incarnation === 'gone' ? 'exited' : true
      },
      () => false,
      undefined,
      { incarnationOf: () => incarnation }
    )
    backpressure.setQueued('client', new Map([['tui', 200 * 1024]]))
    backpressure.setQueued('client', new Map([['tui', 201 * 1024]]))
    expect(pauseCalls).toBe(1)

    incarnation = 'respawned'
    backpressure.noteSessionOutput('tui')
    backpressure.setQueued('client', new Map([['tui', 202 * 1024]]))
    expect(pauseCalls).toBe(2)
  })

  it('a respawn does not inherit keep-tail dropping from its stalled predecessor', () => {
    let incarnation = 'first'
    const { backpressure, stall } = recordingBackpressure({ incarnationOf: () => incarnation })
    backpressure.setQueued('client', new Map([['tui', 200 * 1024]]))
    stall()?.('timeout')
    expect(backpressure.isStallReleased('tui')).toBe(true)

    incarnation = 'second'
    backpressure.noteSessionOutput('tui')
    expect(backpressure.isStallReleased('tui')).toBe(false)
  })

  it('a termination that fails leaves the session pausable again', () => {
    let terminating = true
    let pauseCalls = 0
    let owner: StallHandler | undefined
    const backpressure = new DaemonStreamBackpressure(
      (_sessionId, isPaused, onStall) => {
        if (!isPaused) {
          return
        }
        pauseCalls += 1
        owner = onStall
        return terminating ? 'terminating' : true
      },
      () => false
    )
    backpressure.setQueued('client', new Map([['tui', 200 * 1024]]))
    backpressure.setQueued('client', new Map([['tui', 201 * 1024]]))
    expect(pauseCalls).toBe(1)

    terminating = false
    owner?.('released')
    backpressure.setQueued('client', new Map([['tui', 202 * 1024]]))
    expect(pauseCalls).toBe(2)
  })

  it('a viewerless producer is skipped until a client attaches, then pauses again', () => {
    const subprocess = { pause: vi.fn(), resume: vi.fn() }
    const producer = new SessionProducerPause(subprocess)
    let viewer: true | 'detached' = 'detached'
    let pauseCalls = 0
    const backpressure = new DaemonStreamBackpressure(
      (_sessionId, isPaused, onStall) => {
        if (!isPaused) {
          return producer.resumeClient('stream')
        }
        pauseCalls += 1
        return producer.pause('stream', viewer, onStall)
      },
      () => false
    )
    backpressure.setQueued('client', new Map([['tui', 200 * 1024]]))
    backpressure.setQueued('client', new Map([['tui', 201 * 1024]]))
    expect(pauseCalls).toBe(1)

    viewer = true
    producer.noteViewerAttached(true)
    backpressure.setQueued('client', new Map([['tui', 202 * 1024]]))
    expect(pauseCalls).toBe(2)
    expect(subprocess.pause).toHaveBeenCalledTimes(1)
  })

  it('a release keeps keep-tail until the stalled backlog drains, then pauses normally', () => {
    let pauseCalls = 0
    let owner: StallHandler | undefined
    const backpressure = new DaemonStreamBackpressure(
      (_sessionId, isPaused, onStall) => {
        if (isPaused) {
          pauseCalls += 1
          owner = onStall
          return true
        }
        return undefined
      },
      () => false
    )
    backpressure.setQueued('client', new Map([['tui', 200 * 1024]]))
    owner?.('timeout')
    owner?.('terminating')
    owner?.('released')
    backpressure.setQueued('client', new Map([['tui', 201 * 1024]]))
    expect(backpressure.isStallReleased('tui')).toBe(true)
    expect(pauseCalls).toBe(1)

    backpressure.setQueued('client', new Map())
    backpressure.setQueued('client', new Map([['tui', 202 * 1024]]))
    expect(pauseCalls).toBe(2)
  })

  it('keep-tail and unpausable both clear once a stalled, then terminating, session drains', () => {
    let pauseCalls = 0
    let owner: StallHandler | undefined
    const backpressure = new DaemonStreamBackpressure(
      (_sessionId, isPaused, onStall) => {
        if (isPaused) {
          pauseCalls += 1
          owner = onStall
          return true
        }
        return undefined
      },
      () => false
    )
    backpressure.setQueued('client', new Map([['tui', 200 * 1024]]))
    owner?.('timeout')
    owner?.('terminating')
    expect(backpressure.isStallReleased('tui')).toBe(true)

    backpressure.setQueued('client', new Map())
    expect(backpressure.isStallReleased('tui')).toBe(false)
    backpressure.setQueued('client', new Map([['tui', 201 * 1024]]))
    expect(pauseCalls).toBe(2)
  })

  it('clearing every client leaves no record that later output must look up', () => {
    let lookups = 0
    const { backpressure, stall } = recordingBackpressure({
      incarnationOf: () => {
        lookups += 1
        return 'live'
      }
    })
    backpressure.setQueued('client', new Map([['tui', 200 * 1024]]))
    stall()?.('timeout')
    backpressure.clear()
    const afterClear = lookups
    backpressure.noteSessionOutput('tui')
    expect(lookups).toBe(afterClear)
  })

  it('does not count an empty refill frame as the held session delivering', async () => {
    const { backpressure, stall } = recordingBackpressure()
    backpressure.setQueued('client', new Map([['tui', 200 * 1024]]))
    backpressure.write('client', 'tui', completingSocket(), 'noop', undefined, false)
    await new Promise((resolve) => process.nextTick(resolve))

    stall()?.('timeout')
    expect(backpressure.isStallReleased('tui')).toBe(true)
  })

  it("closing one connection drops only that connection's delivery credit", async () => {
    const { backpressure, paused, stall } = recordingBackpressure()
    backpressure.setQueued('kept', new Map([['tui', 200 * 1024]]))
    backpressure.write('kept', 'tui', completingSocket(), 'x')
    await new Promise((resolve) => process.nextTick(resolve))
    backpressure.clear('other')

    stall()?.('timeout')
    expect(paused.get('tui')).toBe(false)
    expect(backpressure.isStallReleased('tui')).toBe(false)
  })

  it("forgets a disconnected client's deliveries", async () => {
    const { backpressure, stall } = recordingBackpressure()
    backpressure.setQueued('stalled', new Map([['tui', 200 * 1024]]))
    backpressure.write('gone', 'tui', completingSocket(), 'x')
    await new Promise((resolve) => process.nextTick(resolve))
    backpressure.clear('gone')

    stall()?.('timeout')
    expect(backpressure.isStallReleased('tui')).toBe(true)
  })
})

function completingSocket(): Writable {
  return new Writable({
    write(_chunk, _encoding, done) {
      done()
    }
  })
}
