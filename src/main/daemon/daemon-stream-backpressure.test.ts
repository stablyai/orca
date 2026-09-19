import { describe, expect, it, vi } from 'vitest'
import { DaemonStreamBackpressure } from './daemon-stream-backpressure'
import { DaemonStreamHeldRefill } from './daemon-stream-held-refill'

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
  it('aggregates held output across clients and spares low-output sessions', () => {
    const { pressure, paused } = createBackpressure()
    pressure.setQueued(
      'a',
      new Map([
        ['flood-a', MiB],
        ['typing', 4]
      ])
    )
    expect(paused.size).toBe(0)
    pressure.setQueued('b', new Map([['flood-b', MiB]]))
    expect([...paused].sort()).toEqual(['flood-a', 'flood-b'])
    pressure.clear()
    expect(paused.size).toBe(0)
  })

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

  it('releases a drained session while another client remains stalled', () => {
    const { pressure, paused } = createBackpressure()
    pressure.setQueued('a', new Map([['flood-a', 2 * MiB]]))
    pressure.setQueued('b', new Map([['flood-b', MiB]]))
    expect(paused.has('flood-b')).toBe(true)
    pressure.setQueued('b', new Map())
    expect([...paused]).toEqual(['flood-a'])
  })

  it('leaves background shedding in control when a session becomes hidden', () => {
    let hidden = false
    const { pressure, paused } = createBackpressure(() => hidden)
    pressure.setQueued('a', new Map([['flood', 2 * MiB]]))
    expect(paused.has('flood')).toBe(true)
    hidden = true
    pressure.refresh()
    expect(paused.size).toBe(0)
    pressure.setQueued('a', new Map([['flood', 3 * MiB]]))
    expect(paused.size).toBe(0)
  })

  it('uses hysteresis and resumes after the aggregate falls below the low watermark', () => {
    const { pressure, paused } = createBackpressure()
    pressure.setQueued('a', new Map([['flood', 2 * MiB]]))
    pressure.setQueued('a', new Map([['flood', MiB]]))
    expect(paused.has('flood')).toBe(true)
    pressure.setQueued('a', new Map([['flood', MiB / 2]]))
    expect(paused.size).toBe(0)
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
    expect(setPaused).toHaveBeenLastCalledWith('session', true)
    owner = 'new'
    pressure.refresh()
    expect(setPaused).toHaveBeenLastCalledWith('session', false)
    setPaused.mockClear()
    pressure.setQueued('new', new Map([['session', 1024]]))
    expect(setPaused).not.toHaveBeenCalled()
  })

  it('bounds undroppable control output even when the producer is backgrounded', () => {
    const { pressure, paused } = createBackpressure(() => true)
    pressure.setQueued('a', new Map([['hidden', 2 * MiB]]), new Map([['hidden', 4 * MiB]]))
    expect(paused.has('hidden')).toBe(true)
    pressure.setQueued('a', new Map([['hidden', 2 * MiB]]))
    expect(paused.size).toBe(0)
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

  it('does not let an old refill callback flush a replacement connection', () => {
    const flush = vi.fn()
    const completions: (() => void)[] = []
    const write = (_line: string, complete: () => void) => completions.push(complete)
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
