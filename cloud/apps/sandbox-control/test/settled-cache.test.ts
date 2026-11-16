import { describe, expect, it } from 'vitest'
import { settledCache } from '../src/settled-cache'

describe('settledCache', () => {
  it('never hands a request another request’s in-flight load; shares the value once settled', async () => {
    const cache = settledCache<number>(1000)
    let loads = 0
    let release: (value: number) => void = () => {}
    const slow = () => new Promise<number>((resolve) => ((loads++), (release = resolve)))
    const first = cache.get('k', 0, slow)
    // A second request while the first is loading loads for itself.
    const second = cache.get('k', 1, async () => (loads++, 2))
    expect(await second).toBe(2)
    release(1)
    expect(await first).toBe(1)
    expect(loads).toBe(2)
    // Settled now: fresh hits reuse the value, stale ones load again.
    expect(await cache.get('k', 10, async () => (loads++, 3))).toBe(1)
    expect(await cache.get('k', 5000, async () => (loads++, 4))).toBe(4)
    expect(loads).toBe(3)
  })

  it('a failed load is not cached', async () => {
    const cache = settledCache<number>(1000)
    await expect(cache.get('k', 0, async () => Promise.reject(new Error('down')))).rejects.toThrow('down')
    expect(await cache.get('k', 1, async () => 7)).toBe(7)
  })
})
