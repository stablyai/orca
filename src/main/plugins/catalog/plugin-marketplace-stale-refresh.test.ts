import { describe, expect, it, vi } from 'vitest'
import type { PluginMarketplaceSourceState } from './plugin-marketplace-projection'
import {
  createStaleMarketplaceRefresh,
  MISSING_SNAPSHOT_RETRY_MS
} from './plugin-marketplace-stale-refresh'

const HOUR = 60 * 60 * 1000

function source(id: string, fetchedAt: number | null): PluginMarketplaceSourceState {
  return {
    id,
    source: { kind: 'git', url: `https://github.com/community/${id}.git`, ref: 'main' },
    addedAt: 0,
    marketplace:
      fetchedAt === null
        ? null
        : { name: id, owner: 'community', resolvedCommit: 'a'.repeat(40), fetchedAt },
    stale: false,
    official: false
  }
}

function setup(sources: PluginMarketplaceSourceState[]) {
  const refreshSource = vi.fn(async (id: string) => source(id, 100 * HOUR))
  const refresh = createStaleMarketplaceRefresh({
    listSources: async () => sources,
    refreshSource
  })
  return { refresh, refreshSource }
}

describe('createStaleMarketplaceRefresh', () => {
  it('refreshes stale and missing catalogs, not fresh ones', async () => {
    const { refresh, refreshSource } = setup([
      source('fresh', 10 * HOUR),
      source('stale', 0),
      source('missing', null)
    ])
    await refresh(6 * HOUR, 12 * HOUR)
    expect(refreshSource.mock.calls).toEqual([['stale'], ['missing']])
  })

  it('retries a catalog whose first fetch failed after a short wait', async () => {
    const { refresh, refreshSource } = setup([source('missing', null)])
    await refresh(6 * HOUR, 0)
    await refresh(6 * HOUR, MISSING_SNAPSHOT_RETRY_MS - 1)
    expect(refreshSource).toHaveBeenCalledTimes(1)
    await refresh(6 * HOUR, MISSING_SNAPSHOT_RETRY_MS)
    expect(refreshSource).toHaveBeenCalledTimes(2)
  })

  it('tries a stale catalog once per window, even when the fetch fails', async () => {
    const { refresh, refreshSource } = setup([source('stale', 0)])
    refreshSource.mockRejectedValueOnce(new Error('offline'))
    await refresh(6 * HOUR, 7 * HOUR)
    await refresh(6 * HOUR, 8 * HOUR)
    expect(refreshSource).toHaveBeenCalledTimes(1)
    await refresh(6 * HOUR, 13 * HOUR)
    expect(refreshSource).toHaveBeenCalledTimes(2)
  })

  it('shares one pass between concurrent callers', async () => {
    const { refresh, refreshSource } = setup([source('stale', 0)])
    await Promise.all([refresh(6 * HOUR, 7 * HOUR), refresh(6 * HOUR, 7 * HOUR)])
    expect(refreshSource).toHaveBeenCalledTimes(1)
  })
})
