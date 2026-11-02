import { expect, it, vi } from 'vitest'
import { createPushReadiness } from './push-readiness.js'
import type { PushDatabase } from './push-database.js'

it('shares a slow check and caches failures before retrying', async () => {
  let clock = 0
  let reject!: (error: Error) => void
  const query = vi.fn(
    () =>
      new Promise<never>((_, fail) => {
        reject = fail
      })
  )
  const ready = createPushReadiness({ query } as unknown as PushDatabase, { now: () => clock })
  const checks = Array.from({ length: 100 }, () => ready())
  expect(query).toHaveBeenCalledTimes(1)
  reject(new Error('offline'))
  expect(await Promise.all(checks)).toEqual(Array(100).fill(false))
  expect(await ready()).toBe(false)
  expect(query).toHaveBeenCalledTimes(1)
  clock = 10_000
  const retry = ready()
  expect(query).toHaveBeenCalledTimes(2)
  reject(new Error('offline'))
  expect(await retry).toBe(false)
})
