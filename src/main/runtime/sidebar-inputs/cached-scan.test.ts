import { describe, expect, it, vi } from 'vitest'
import { CachedScan } from './cached-scan'

function scanner(demand = true) {
  const pending: { value: number; resolve: () => void }[] = []
  const applied: number[] = []
  let next = 0
  const cache = new CachedScan<number>({
    label: 'test',
    demand: () => demand,
    applied: (value) => applied.push(value),
    scan: () => {
      const value = ++next
      return new Promise<number>((resolve) => {
        pending.push({ value, resolve: () => resolve(value) })
      })
    }
  })
  const finish = async (): Promise<void> => {
    pending.shift()?.resolve()
    await vi.waitFor(() => {})
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { cache, pending, applied, finish }
}

describe('CachedScan', () => {
  it('runs one scan at a time and one more for every request made during it', async () => {
    const { cache, pending, applied, finish } = scanner()
    cache.request()
    cache.request()
    cache.request()
    expect(pending).toHaveLength(1)
    await finish()
    expect(applied).toEqual([1])
    expect(pending).toHaveLength(1)
    await finish()
    expect(applied).toEqual([1, 2])
    expect(cache.current).toBe(2)
    expect(pending).toHaveLength(0)
  })

  it('scans for a first reader and serves later readers from the cache', async () => {
    const { cache, pending, finish } = scanner(false)
    const ready = cache.ready()
    expect(pending).toHaveLength(1)
    await finish()
    await ready
    await cache.ready()
    expect(pending).toHaveLength(0)
  })

  it('runs no scan without demand, but makes the next reader scan again', async () => {
    const { cache, pending, finish } = scanner(false)
    const first = cache.ready()
    await finish()
    await first
    cache.request()
    expect(pending).toHaveLength(0)
    const second = cache.ready()
    expect(pending).toHaveLength(1)
    await finish()
    await second
    expect(cache.current).toBe(2)
  })

  it('keeps the last result when a scan fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let fail = false
    const cache = new CachedScan<number>({
      label: 'test',
      demand: () => true,
      applied: () => {},
      scan: async () => {
        if (fail) {
          throw new Error('git failed')
        }
        return 1
      }
    })
    await cache.ready()
    fail = true
    cache.request()
    await cache.settled()
    expect(cache.current).toBe(1)
    vi.restoreAllMocks()
  })
})
