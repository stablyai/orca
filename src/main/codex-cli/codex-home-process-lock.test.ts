import { describe, expect, it, vi } from 'vitest'
import { withCodexHomeProcessLock } from './codex-home-process-lock'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('withCodexHomeProcessLock', () => {
  it('does not release a running lock based on elapsed time', async () => {
    vi.useFakeTimers()
    try {
      const events: string[] = []
      const gate = deferred()
      const first = withCodexHomeProcessLock('home-long-running', async () => {
        events.push('first:start')
        await gate.promise
      })
      const second = withCodexHomeProcessLock('home-long-running', async () => {
        events.push('second:start')
      })

      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(events).toEqual(['first:start'])

      gate.resolve()
      await Promise.all([first, second])
      expect(events).toEqual(['first:start', 'second:start'])
    } finally {
      vi.useRealTimers()
    }
  })
})
