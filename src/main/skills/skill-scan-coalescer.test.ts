import { describe, expect, it } from 'vitest'
import { SkillScanCoalescer } from './skill-scan-coalescer'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('SkillScanCoalescer', () => {
  it('collapses concurrent callers on one key into a single scan', async () => {
    const coalescer = new SkillScanCoalescer<number>(8)
    const gate = deferred<number>()
    let runs = 0
    const task = (): Promise<number> => {
      runs += 1
      return gate.promise
    }

    const outcomes = Promise.all([
      coalescer.run('root', { ttlMs: 0 }, task),
      coalescer.run('root', { ttlMs: 0 }, task),
      coalescer.run('root', { ttlMs: 0 }, task)
    ])
    gate.resolve(7)

    expect((await outcomes).map((outcome) => outcome.value)).toEqual([7, 7, 7])
    expect((await outcomes).map((outcome) => outcome.cached)).toEqual([false, true, true])
    expect(runs).toBe(1)
  })

  it('keeps distinct keys isolated, including paths differing only by case', async () => {
    const coalescer = new SkillScanCoalescer<string>(8)
    const seen: string[] = []
    const run = (key: string): Promise<{ value: string }> =>
      coalescer.run(key, { ttlMs: 1_000 }, async () => {
        seen.push(key)
        return key
      })

    const [lower, upper] = await Promise.all([run('/home/a/Skills'), run('/home/a/skills')])

    expect(lower.value).toBe('/home/a/Skills')
    expect(upper.value).toBe('/home/a/skills')
    expect(seen).toHaveLength(2)
  })

  it('reuses a result inside the ttl and rescans after it lapses', async () => {
    let now = 1_000
    const coalescer = new SkillScanCoalescer<number>(8, () => now)
    let runs = 0
    const task = async (): Promise<number> => {
      runs += 1
      return runs
    }

    expect((await coalescer.run('root', { ttlMs: 100 }, task)).cached).toBe(false)
    now = 1_050
    const cached = await coalescer.run('root', { ttlMs: 100 }, task)
    expect(cached).toEqual({ value: 1, cached: true })
    now = 1_101
    expect(await coalescer.run('root', { ttlMs: 100 }, task)).toEqual({ value: 2, cached: false })
    expect(runs).toBe(2)
  })

  it('retains nothing when the ttl is zero', async () => {
    const coalescer = new SkillScanCoalescer<number>(8)
    let runs = 0
    const task = async (): Promise<number> => {
      runs += 1
      return runs
    }

    await coalescer.run('root', { ttlMs: 0 }, task)
    await coalescer.run('root', { ttlMs: 0 }, task)

    expect(runs).toBe(2)
  })

  it('bypasses cached and in-flight results when refreshing', async () => {
    let now = 1_000
    const coalescer = new SkillScanCoalescer<number>(8, () => now)
    let runs = 0
    const task = async (): Promise<number> => {
      runs += 1
      return runs
    }

    await coalescer.run('root', { ttlMs: 10_000 }, task)
    const refreshed = await coalescer.run('root', { ttlMs: 10_000, refresh: true }, task)

    expect(refreshed).toEqual({ value: 2, cached: false })
    // The refreshed result is what later readers see, not the entry it replaced.
    expect(await coalescer.run('root', { ttlMs: 10_000 }, task)).toEqual({ value: 2, cached: true })
    expect(runs).toBe(2)
  })

  // Why: discovery issues one refreshing run() per root, synchronously. An
  // invalidation counter shared across keys would let only the last-issued root
  // publish and silently discard the rest, so every later scan re-walks them.
  it('caches every key when a refresh fans out across roots', async () => {
    const coalescer = new SkillScanCoalescer<string>(64)
    const keys = ['root-a', 'root-b', 'root-c', 'root-d']

    await Promise.all(
      keys.map((key) => coalescer.run(key, { ttlMs: 10_000, refresh: true }, async () => key))
    )
    const readBack = await Promise.all(
      keys.map((key) => coalescer.run(key, { ttlMs: 10_000 }, async () => 're-walked'))
    )

    expect(readBack.map((outcome) => outcome.cached)).toEqual([true, true, true, true])
    expect(readBack.map((outcome) => outcome.value)).toEqual(keys)
  })

  it('does not let a scan that started before a refresh publish its stale result', async () => {
    const coalescer = new SkillScanCoalescer<string>(8)
    const slowScan = deferred<string>()

    // A focus/mount scan is already in flight when the user installs a skill.
    const inFlight = coalescer.run('root', { ttlMs: 10_000 }, () => slowScan.promise)
    const refreshed = await coalescer.run(
      'root',
      { ttlMs: 10_000, refresh: true },
      async () => 'after-install'
    )
    expect(refreshed.value).toBe('after-install')

    // The older scan now lands. It must not overwrite the post-install entry with
    // a pre-install listing and a fresh lifetime.
    slowScan.resolve('before-install')
    await inFlight

    expect(await coalescer.run('root', { ttlMs: 10_000 }, async () => 'rescanned')).toEqual({
      value: 'after-install',
      cached: true
    })
  })

  it('does not let a scan that started before clear() repopulate the cache', async () => {
    const coalescer = new SkillScanCoalescer<string>(8)
    const slowScan = deferred<string>()

    const inFlight = coalescer.run('root', { ttlMs: 10_000 }, () => slowScan.promise)
    // A skill update run rewrote disk while that scan was walking it.
    coalescer.clear()
    slowScan.resolve('pre-update')
    await inFlight

    expect(await coalescer.run('root', { ttlMs: 10_000 }, async () => 'post-update')).toEqual({
      value: 'post-update',
      cached: false
    })
  })

  it('does not cache a failed scan', async () => {
    const coalescer = new SkillScanCoalescer<number>(8)
    let runs = 0

    await expect(
      coalescer.run('root', { ttlMs: 10_000 }, async () => {
        runs += 1
        throw new Error('scan failed')
      })
    ).rejects.toThrow('scan failed')
    expect(await coalescer.run('root', { ttlMs: 10_000 }, async () => 5)).toEqual({
      value: 5,
      cached: false
    })
    expect(runs).toBe(1)
  })

  it('evicts the least recently used entry past the bound', async () => {
    let now = 1_000
    const coalescer = new SkillScanCoalescer<string>(2, () => now)
    const scan = (key: string): Promise<{ cached: boolean }> =>
      coalescer.run(key, { ttlMs: 10_000 }, async () => key)

    await scan('a')
    await scan('b')
    // Reading 'a' promotes it, so 'b' is the eviction candidate when 'c' arrives.
    expect((await scan('a')).cached).toBe(true)
    await scan('c')

    expect((await scan('a')).cached).toBe(true)
    expect((await scan('b')).cached).toBe(false)
  })

  // ttl is non-zero on purpose: with ttl 0 nothing is ever written, which hides
  // whether the abandoned scan can still publish over the replacement's result.
  it('stops joining a scan that never settles, and never lets it publish later', async () => {
    let now = 1_000
    const coalescer = new SkillScanCoalescer<number>(8, () => now)
    const wedged = deferred<number>()
    let runs = 0
    const task = (): Promise<number> => {
      runs += 1
      // The first scan models a root on a stalled mount: its readdir never settles.
      return runs === 1 ? wedged.promise : Promise.resolve(runs)
    }

    void coalescer.run('root', { ttlMs: 10_000 }, task)
    now = 1_100
    // Still young enough to share.
    const joined = coalescer.run('root', { ttlMs: 10_000 }, task)
    now = 40_000

    expect(await coalescer.run('root', { ttlMs: 10_000 }, task)).toEqual({
      value: 2,
      cached: false
    })
    expect(runs).toBe(2)

    // The wedged callers still receive its eventual value rather than being orphaned...
    wedged.resolve(99)
    expect((await joined).value).toBe(99)
    // ...but it must not overwrite the replacement's newer result with a fresh ttl.
    expect(await coalescer.run('root', { ttlMs: 10_000 }, task)).toEqual({ value: 2, cached: true })
  })
})
