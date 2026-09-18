import { describe, expect, it, vi } from 'vitest'
import { createNpmPackageInfoCache } from './npm-package-info-cache'
import type { NpmPackageInfoResult } from '../../shared/npm-package-info-types'

const okResult = (version: string): NpmPackageInfoResult => ({
  status: 'ok',
  info: {
    packageName: 'react',
    description: null,
    latestVersion: version,
    latestPublishedAt: null,
    homepageUrl: null,
    repositoryUrl: null,
    source: 'registry-http'
  }
})

describe('createNpmPackageInfoCache', () => {
  it('caches an ok result for 10 minutes, expiring exactly after', async () => {
    let now = 0
    const cache = createNpmPackageInfoCache(() => now)
    const run = vi.fn().mockResolvedValue(okResult('19.0.0'))

    await cache.getOrRun('local\0react', run)
    now = 10 * 60 * 1000 - 1
    await cache.getOrRun('local\0react', run)
    expect(run).toHaveBeenCalledTimes(1)

    now = 10 * 60 * 1000 + 1
    await cache.getOrRun('local\0react', run)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('caches a not-found result for 10 minutes too', async () => {
    let now = 0
    const cache = createNpmPackageInfoCache(() => now)
    const run = vi.fn().mockResolvedValue({ status: 'not-found' } satisfies NpmPackageInfoResult)

    await cache.getOrRun('local\0ghost', run)
    now = 10 * 60 * 1000 - 1
    await cache.getOrRun('local\0ghost', run)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('caches an unavailable result for only 30 seconds', async () => {
    let now = 0
    const cache = createNpmPackageInfoCache(() => now)
    const run = vi.fn().mockResolvedValue({
      status: 'unavailable',
      reason: 'timeout'
    } satisfies NpmPackageInfoResult)

    await cache.getOrRun('local\0react', run)
    now = 30 * 1000 - 1
    await cache.getOrRun('local\0react', run)
    expect(run).toHaveBeenCalledTimes(1)

    now = 30 * 1000 + 1
    await cache.getOrRun('local\0react', run)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('never caches lookup-disabled, always re-running', async () => {
    const cache = createNpmPackageInfoCache()
    const run = vi
      .fn()
      .mockResolvedValue({ status: 'lookup-disabled' } satisfies NpmPackageInfoResult)

    await cache.getOrRun('local\0react', run)
    await cache.getOrRun('local\0react', run)

    expect(run).toHaveBeenCalledTimes(2)
  })

  it('evicts the oldest entry once the bound of 500 is exceeded', async () => {
    const cache = createNpmPackageInfoCache()
    for (let index = 0; index < 500; index += 1) {
      await cache.getOrRun(`key-${index}`, () => Promise.resolve(okResult('1.0.0')))
    }
    const runForFirstKey = vi.fn().mockResolvedValue(okResult('2.0.0'))
    await cache.getOrRun('key-0', runForFirstKey)
    expect(runForFirstKey).not.toHaveBeenCalled()

    await cache.getOrRun('key-500', () => Promise.resolve(okResult('1.0.0')))

    const runAgainForFirstKey = vi.fn().mockResolvedValue(okResult('3.0.0'))
    await cache.getOrRun('key-0', runAgainForFirstKey)
    expect(runAgainForFirstKey).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent lookups for the same key into a single run', async () => {
    const cache = createNpmPackageInfoCache()
    let resolveRun: (result: NpmPackageInfoResult) => void = () => {}
    const run = vi.fn(() => new Promise<NpmPackageInfoResult>((resolve) => (resolveRun = resolve)))

    const first = cache.getOrRun('local\0react', run)
    const second = cache.getOrRun('local\0react', run)
    resolveRun(okResult('19.0.0'))

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(run).toHaveBeenCalledTimes(1)
    expect(firstResult).toEqual(okResult('19.0.0'))
    expect(secondResult).toEqual(okResult('19.0.0'))
  })

  it('clears every cached entry, forcing a re-run on the next call', async () => {
    const cache = createNpmPackageInfoCache()
    const run = vi.fn().mockResolvedValue(okResult('19.0.0'))

    await cache.getOrRun('local\0react', run)
    cache.clear()
    await cache.getOrRun('local\0react', run)

    expect(run).toHaveBeenCalledTimes(2)
  })
})
