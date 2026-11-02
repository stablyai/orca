import { describe, expect, it, vi } from 'vitest'
import type { ReleaseBuild } from '../shared/release-channel'
import { ReleaseBuildListCache } from './updater-release-build-cache'

const build = (tag: string): ReleaseBuild => ({
  tag,
  version: tag.slice(1),
  channel: 'hourly',
  name: null,
  publishedAt: null,
  releaseUrl: `https://github.com/stablyai/orca-hourly/releases/tag/${tag}`,
  installerUrl: null
})

const TTL_MS = 5 * 60_000

function createCache(load = vi.fn().mockResolvedValue([build('v1.4.160-hourly.202607281400')])) {
  let now = 1_000_000
  const cache = new ReleaseBuildListCache(load, TTL_MS, () => now)
  return { cache, load, advance: (ms: number) => (now += ms) }
}

describe('ReleaseBuildListCache', () => {
  it('shares one in-flight load between concurrent callers', async () => {
    const { cache, load } = createCache()

    const [first, second] = await Promise.all([cache.list('hourly'), cache.list('hourly')])

    expect(load).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
  })

  it('does not cache a failed load', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('GitHub rate limit reached.'))
      .mockResolvedValueOnce([build('v1.4.160-hourly.202607281400')])
    const { cache } = createCache(load)

    await expect(cache.list('hourly')).rejects.toThrow(/rate limit/)
    await expect(cache.list('hourly')).resolves.toHaveLength(1)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('keeps a forced reload that replaced a failing entry', async () => {
    let failFirst: (error: Error) => void = () => {}
    const load = vi
      .fn()
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          failFirst = reject
        })
      )
      .mockResolvedValueOnce([build('v1.4.160-hourly.202607281400')])
    const { cache } = createCache(load)

    const failing = cache.list('hourly')
    const forced = cache.list('hourly', { force: true })
    failFirst(new Error('timed out'))
    await expect(failing).rejects.toThrow(/timed out/)
    await forced

    await cache.list('hourly')
    expect(load).toHaveBeenCalledTimes(2)
  })
})
