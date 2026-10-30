import { describe, expect, it } from 'vitest'
import { SkillScanCoalescer, SkillScanShedError } from './skill-scan-coalescer'

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
    expect(await coalescer.run('root', { ttlMs: 10_000 }, task)).toEqual({ value: 2, cached: true })
    expect(runs).toBe(2)
  })

  // Refresh fan-out needs per-key publish ownership; a global counter would cache only the last root.
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

    const inFlight = coalescer.run('root', { ttlMs: 10_000 }, () => slowScan.promise)
    const refreshed = await coalescer.run(
      'root',
      { ttlMs: 10_000, refresh: true },
      async () => 'after-install'
    )
    expect(refreshed.value).toBe('after-install')

    // A pre-install scan must not overwrite the refreshed result with a new lifetime.
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
    expect((await scan('a')).cached).toBe(true)
    await scan('c')

    expect((await scan('a')).cached).toBe(true)
    expect((await scan('b')).cached).toBe(false)
  })

  // Use nonzero TTL to expose abandoned scans incorrectly publishing over replacements.
  it('stops joining a scan that never settles, and never lets it publish later', async () => {
    let now = 1_000
    const coalescer = new SkillScanCoalescer<number>(8, () => now)
    const wedged = deferred<number>()
    let runs = 0
    const task = (signal: AbortSignal): Promise<number> => {
      runs += 1
      // Model a stalled mount whose syscall never settles.
      return runs === 1
        ? Promise.race([
            wedged.promise,
            new Promise<number>((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason))
            })
          ])
        : Promise.resolve(runs)
    }

    void coalescer.run('root', { ttlMs: 10_000 }, task).catch(() => undefined)
    now = 1_100
    const joined = coalescer.run('root', { ttlMs: 10_000 }, task)
    now = 40_000

    expect(await coalescer.run('root', { ttlMs: 10_000 }, task)).toEqual({
      value: 2,
      cached: false
    })
    expect(runs).toBe(2)

    // Abort releases abandoned-scan callers even if the mount never answers.
    await expect(joined).rejects.toThrow()
    wedged.resolve(99)
    expect(await coalescer.run('root', { ttlMs: 10_000 }, task)).toEqual({ value: 2, cached: true })
  })

  it('aborts the scan it abandons so its walk stops doing filesystem work', async () => {
    let now = 1_000
    const coalescer = new SkillScanCoalescer<number>(8, () => now)
    const signals: AbortSignal[] = []
    const task = (signal: AbortSignal): Promise<number> => {
      signals.push(signal)
      return signals.length === 1 ? new Promise<number>(() => {}) : Promise.resolve(2)
    }

    void coalescer.run('root', { ttlMs: 10_000 }, task).catch(() => undefined)
    expect(signals[0].aborted).toBe(false)
    now = 40_000
    await coalescer.run('root', { ttlMs: 10_000 }, task)

    expect(signals[0].aborted).toBe(true)
    // The new owner must not be aborted with its predecessor.
    expect(signals[1].aborted).toBe(false)
  })

  // Keep healthy superseded callers alive; publish ownership already prevents stale caching.
  it('does not abort the scan a refresh supersedes', async () => {
    const coalescer = new SkillScanCoalescer<string>(8)
    const slowScan = deferred<string>()
    const signals: AbortSignal[] = []

    const inFlight = coalescer.run('root', { ttlMs: 10_000 }, (signal) => {
      signals.push(signal)
      return slowScan.promise
    })
    await coalescer.run('root', { ttlMs: 10_000, refresh: true }, async () => 'after-install')

    expect(signals[0].aborted).toBe(false)
    slowScan.resolve('before-install')
    expect((await inFlight).value).toBe('before-install')
  })

  // A stuck syscall cannot settle on abort; budget abandoned scans until actual completion.
  it('sheds a replacement once too many abandoned scans are still live', async () => {
    let now = 1_000
    const coalescer = new SkillScanCoalescer<number>(64, () => now)
    const task = (): Promise<number> => new Promise<number>(() => {})
    const keys = Array.from({ length: 17 }, (_unused, index) => `root-${index}`)

    // Each stalled root spends abandonment budget when a caller seeks a replacement.
    for (const key of keys) {
      void coalescer.run(key, { ttlMs: 10_000 }, task).catch(() => undefined)
    }
    now = 40_000
    const shed: string[] = []
    for (const key of keys) {
      void coalescer.run(key, { ttlMs: 10_000 }, task).catch((error: unknown) => {
        if (error instanceof SkillScanShedError) {
          shed.push(key)
        }
      })
    }
    await new Promise((resolve) => setImmediate(resolve))

    expect(shed).toEqual(['root-16'])
  })
})
