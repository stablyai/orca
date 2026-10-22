import { describe, expect, it } from 'vitest'
import { AssignmentRejectionLogWindow } from './assignment-rejection-log-window.js'

describe('assignment rejection log window', () => {
  it('emits once per key per window and closes it with its own suppressed count', () => {
    const timers = manualTimers()
    const closed: { key: string; suppressed: number; sample: string }[] = []
    const window = new AssignmentRejectionLogWindow<string>({
      windowMs: 10_000,
      schedule: timers.schedule,
      onWindowClosed: (input) => closed.push(input)
    })
    const key = 'assign:placement:host-rate-limited'

    expect(window.admit(key, 'host-a')).toBe(true)
    expect(window.admit(key, 'host-b')).toBe(false)
    expect(window.admit(key, 'host-c')).toBe(false)
    expect(closed).toEqual([])

    timers.runPending()
    expect(closed).toEqual([{ key, suppressed: 2, sample: 'host-c' }])

    // The next window starts clean instead of inheriting the closed window's count.
    expect(window.admit(key, 'host-d')).toBe(true)
    timers.runPending()
    expect(closed).toHaveLength(1)
  })

  it('reports the final count for a key that goes quiet', () => {
    const timers = manualTimers()
    const closed: { key: string; suppressed: number }[] = []
    const window = new AssignmentRejectionLogWindow<string>({
      windowMs: 10_000,
      schedule: timers.schedule,
      onWindowClosed: ({ key, suppressed }) => closed.push({ key, suppressed })
    })

    window.admit('assign:sticky:host-rate-limited', 'host-a')
    window.admit('assign:sticky:host-rate-limited', 'host-a')
    window.admit('assign:sticky:host-rate-limited', 'host-a')
    // No further rejection ever arrives for this key.
    timers.runPending()

    expect(closed).toEqual([{ key: 'assign:sticky:host-rate-limited', suppressed: 2 }])
  })

  it('keeps distinct keys on independent windows', () => {
    const timers = manualTimers()
    const window = new AssignmentRejectionLogWindow<string>({
      windowMs: 10_000,
      schedule: timers.schedule,
      onWindowClosed: () => undefined
    })

    expect(window.admit('assign:placement:host-rate-limited', 'host-a')).toBe(true)
    expect(window.admit('assign:placement:queue-full', 'host-a')).toBe(true)
    expect(window.admit('assign:sticky:host-rate-limited', 'host-a')).toBe(true)
    expect(window.admit('assign:placement:queue-full', 'host-a')).toBe(false)
  })

  it('bounds the tracked keys and reports what an evicted window suppressed', () => {
    const timers = manualTimers()
    const closed: { key: string; suppressed: number }[] = []
    const window = new AssignmentRejectionLogWindow<string>({
      windowMs: 10_000,
      schedule: timers.schedule,
      onWindowClosed: ({ key, suppressed }) => closed.push({ key, suppressed })
    })

    window.admit('key-0', 'host-a')
    window.admit('key-0', 'host-b')
    for (let index = 1; index < 200; index++) window.admit(`key-${index}`, 'host-a')

    expect(closed[0]).toEqual({ key: 'key-0', suppressed: 1 })
    // Evicted keys emit again rather than staying silently suppressed.
    expect(window.admit('key-0', 'host-a')).toBe(true)
    expect(window.admit('key-199', 'host-a')).toBe(false)
  })
})

function manualTimers(): {
  schedule: (callback: () => void) => () => void
  runPending: () => void
} {
  const pending = new Map<number, () => void>()
  let nextId = 0
  return {
    schedule: (callback) => {
      const id = nextId++
      pending.set(id, callback)
      return () => pending.delete(id)
    },
    runPending: () => {
      for (const [id, callback] of [...pending]) {
        pending.delete(id)
        callback()
      }
    }
  }
}
