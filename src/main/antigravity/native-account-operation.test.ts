import { afterEach, expect, it, vi } from 'vitest'
import {
  createAntigravityAccountOperation,
  remainingAccountOperationMs,
  withAntigravityAccountOperation
} from './native-account-service'

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

it('does not give a retry another 15 seconds after the first preparation', async () => {
  vi.useFakeTimers()
  const parent = createAntigravityAccountOperation()
  await withAntigravityAccountOperation(async () => {
    await vi.advanceTimersByTimeAsync(8_000)
  }, parent)
  let signal: AbortSignal | undefined
  const retry = withAntigravityAccountOperation(async (operation) => {
    signal = operation.signal
    expect(remainingAccountOperationMs(operation)).toBe(7_000)
    return new Promise<never>(() => {})
  }, parent)
  const rejected = expect(retry).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(7_000)
  await rejected
  expect(signal?.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('bounds the budget with a monotonic clock when the host wall clock changes', async () => {
  vi.useFakeTimers()
  const operation = createAntigravityAccountOperation()
  vi.setSystemTime(Date.now() - 60_000)
  expect(remainingAccountOperationMs(operation)).toBe(15_000)
  await vi.advanceTimersByTimeAsync(8_000)
  vi.setSystemTime(Date.now() + 120_000)
  expect(remainingAccountOperationMs(operation)).toBe(7_000)
  await vi.advanceTimersByTimeAsync(7_000)
  expect(() => remainingAccountOperationMs(operation)).toThrow('timed out')
})

it('cancels blocked account work when the launch is cancelled and cleans up timers', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const parent = createAntigravityAccountOperation(controller.signal)
  let signal: AbortSignal | undefined
  const pending = withAntigravityAccountOperation(async (operation) => {
    signal = operation.signal
    return new Promise<never>(() => {})
  }, parent)
  const rejected = expect(pending).rejects.toThrow('cancelled')
  await vi.advanceTimersByTimeAsync(1)
  controller.abort()
  await rejected
  expect(signal?.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
