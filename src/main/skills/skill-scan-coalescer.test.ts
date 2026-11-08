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
})
