import { afterEach, expect, it, vi } from 'vitest'
import { withAntigravityAccountOperation } from './native-account-operation'

afterEach(() => vi.useRealTimers())
it('shares a 15 second deadline and cancels blocked work', async () => {
  vi.useFakeTimers()
  const start = Date.now()
  let signal: AbortSignal | undefined
  const pending = withAntigravityAccountOperation(async (operation) => {
    expect(operation.deadline).toBe(start + 15_000)
    signal = operation.signal
    return new Promise<never>(() => {})
  })
  const rejected = expect(pending).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(15_000)
  await rejected
  expect(signal?.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
it('cleans up the deadline after successful work', async () => {
  vi.useFakeTimers()
  expect(await withAntigravityAccountOperation(async () => 'done')).toBe('done')
  expect(vi.getTimerCount()).toBe(0)
})
