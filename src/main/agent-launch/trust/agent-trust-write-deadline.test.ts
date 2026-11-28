import { afterEach, expect, it, vi } from 'vitest'
import { awaitValueWithinDeadline } from './agent-trust-write-deadline'

afterEach(() => {
  vi.useRealTimers()
})

it('returns a fallback when a best-effort lookup does not settle', async () => {
  vi.useFakeTimers()
  const pending = new Promise<string>(() => undefined)
  const result = awaitValueWithinDeadline(pending, 100, 'fallback')

  await vi.advanceTimersByTimeAsync(100)

  await expect(result).resolves.toBe('fallback')
})
