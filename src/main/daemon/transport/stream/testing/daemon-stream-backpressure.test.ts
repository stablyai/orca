import { describe, expect, it, vi } from 'vitest'
import { DaemonStreamBackpressure } from '../daemon-stream-backpressure'
import { DaemonStreamHeldRefill } from '../daemon-stream-held-refill'

const MiB = 1024 * 1024

function createBackpressure(isDroppable: (sessionId: string) => boolean = () => false) {
  const paused = new Set<string>()
  const setPaused = vi.fn((sessionId: string, value: boolean) => {
    if (value) {
      paused.add(sessionId)
    } else {
      paused.delete(sessionId)
    }
  })
  return { pressure: new DaemonStreamBackpressure(setPaused, isDroppable), paused, setPaused }
}

describe('DaemonStreamBackpressure', () => {
  it('keeps a shared producer paused until every slow client releases its backlog', () => {
    const { pressure, paused } = createBackpressure()
    pressure.setQueued('a', new Map([['shared', MiB]]))
    pressure.setQueued('b', new Map([['shared', MiB]]))
    expect(paused.has('shared')).toBe(true)
    pressure.clear('a')
    expect(paused.has('shared')).toBe(true)
    pressure.clear('b')
    expect(paused.has('shared')).toBe(false)
  })

  it('does not let a superseded subscription pause the new attachment owner', () => {
    let owner = 'old'
    const setPaused = vi.fn()
    const pressure = new DaemonStreamBackpressure(
      setPaused,
      () => false,
      (clientId) => clientId === owner
    )
    pressure.setQueued('old', new Map([['session', 2 * MiB]]))
    expect(setPaused).toHaveBeenLastCalledWith('session', true, expect.any(Function))
    owner = 'new'
    pressure.refresh()
    expect(setPaused).toHaveBeenLastCalledWith('session', false)
    setPaused.mockClear()
    pressure.setQueued('new', new Map([['session', 1024]]))
    expect(setPaused).not.toHaveBeenCalled()
  })

  it('ignores old write completions after a client and session id are reused', () => {
    const completions: (() => void)[] = []
    const socket = {
      write(...args: unknown[]): boolean {
        const complete = args[1]
        if (typeof complete === 'function') {
          completions.push(() => complete())
        }
        return false
      }
    }
    const { pressure, paused } = createBackpressure()
    const line = 'x'.repeat(4 * MiB)
    pressure.write('client', 'session', socket, line)
    expect(paused.has('session')).toBe(true)
    pressure.clear('client')
    expect(paused.size).toBe(0)
    pressure.write('client', 'session', socket, line)
    completions.shift()?.()
    expect(paused.has('session')).toBe(true)
    completions.shift()?.()
    expect(paused.size).toBe(0)
  })

  it('will not re-pause a stall-released session whose backlog is still undelivered', () => {
    const stallReleased = new Set<string>()
    const { pressure, paused } = createBackpressure((sessionId) => stallReleased.has(sessionId))
    pressure.setQueued('a', new Map([['flood', 2 * MiB]]))
    expect(paused.has('flood')).toBe(true)
    stallReleased.add('flood')
    pressure.releaseStalledSession('flood')
    expect(paused.size).toBe(0)
    // Undroppable metadata must not pause a stall-released producer again.
    pressure.setQueued('a', new Map([['flood', 2 * MiB]]), new Map([['flood', 4 * MiB]]))
    expect(paused.size).toBe(0)
  })

  it('does not let an old refill callback flush a replacement connection', () => {
    const flush = vi.fn()
    const completions: (() => void)[] = []
    const write = (_line: unknown, complete: () => void) => completions.push(complete)
    const refill = new DaemonStreamHeldRefill(flush)
    refill.arm('client', 'session', write)
    refill.clear('client')
    refill.arm('client', 'session', write)
    completions.shift()?.()
    expect(flush).not.toHaveBeenCalled()
    completions.shift()?.()
    expect(flush).toHaveBeenCalledOnce()
  })
})
