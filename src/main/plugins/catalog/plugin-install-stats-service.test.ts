import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePluginInstallStats } from '../../../shared/plugins/catalog/plugin-install-stats'
import {
  fetchPluginInstallStats,
  PLUGIN_INSTALL_STATS_REFRESH_MS,
  PLUGIN_INSTALL_STATS_RETRY_MS,
  PluginInstallStatsService
} from './plugin-install-stats-service'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-install-stats-'))
  roots.push(root)
  return root
}

const NOW = Date.parse('2026-10-30T12:00:00Z')

function stats(installs: number, generatedAt = '2026-10-30T02:00:00Z') {
  return { generatedAt, installs: { 'stablyai.orca-nord-theme': installs } }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PluginInstallStatsService', () => {
  it('returns nothing at first, then the fetched counts, and notifies listeners', async () => {
    const fetcher = vi.fn(async () => stats(1234))
    const service = new PluginInstallStatsService({
      pluginsDataDir: await tempRoot(),
      isFetchAllowed: () => true,
      fetcher,
      now: () => NOW
    })
    const changed = vi.fn()
    service.onChanged(changed)

    expect(await service.getInstallCounts()).toEqual({})
    await service.settled()

    expect(changed).toHaveBeenCalledTimes(1)
    expect(await service.getInstallCounts()).toEqual({ 'stablyai.orca-nord-theme': 1234 })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('serves a fresh disk cache after restart without refetching', async () => {
    const root = await tempRoot()
    const first = new PluginInstallStatsService({
      pluginsDataDir: root,
      isFetchAllowed: () => true,
      fetcher: async () => stats(50),
      now: () => NOW
    })
    await first.getInstallCounts()
    await first.settled()
    await utimes(join(root, 'plugin-install-stats.json'), NOW / 1000, NOW / 1000)

    const fetcher = vi.fn(async () => stats(60))
    const restarted = new PluginInstallStatsService({
      pluginsDataDir: root,
      isFetchAllowed: () => true,
      fetcher,
      now: () => NOW
    })
    expect(await restarted.getInstallCounts()).toEqual({ 'stablyai.orca-nord-theme': 50 })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('refetches once the counts are stale', async () => {
    let now = NOW
    const fetcher = vi.fn(async () => stats(10))
    const service = new PluginInstallStatsService({
      pluginsDataDir: await tempRoot(),
      isFetchAllowed: () => true,
      fetcher,
      now: () => now
    })
    await service.getInstallCounts()
    await service.settled()
    await service.getInstallCounts()
    expect(fetcher).toHaveBeenCalledTimes(1)

    now += PLUGIN_INSTALL_STATS_REFRESH_MS
    await service.getInstallCounts()
    await service.settled()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('never fetches while the network policy forbids it', async () => {
    const fetcher = vi.fn(async () => stats(10))
    const service = new PluginInstallStatsService({
      pluginsDataDir: await tempRoot(),
      isFetchAllowed: () => false,
      fetcher,
      now: () => NOW
    })
    expect(await service.getInstallCounts()).toEqual({})
    await service.settled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('keeps the cached counts after a failed refresh and waits before retrying', async () => {
    let now = NOW
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fetcher = vi
      .fn<() => Promise<ReturnType<typeof stats>>>()
      .mockResolvedValueOnce(stats(10))
      .mockRejectedValue(new Error('offline'))
    const service = new PluginInstallStatsService({
      pluginsDataDir: await tempRoot(),
      isFetchAllowed: () => true,
      fetcher,
      now: () => now
    })
    await service.getInstallCounts()
    await service.settled()
    now += PLUGIN_INSTALL_STATS_REFRESH_MS
    await service.getInstallCounts()
    await service.settled()
    expect(await service.getInstallCounts()).toEqual({ 'stablyai.orca-nord-theme': 10 })
    expect(fetcher).toHaveBeenCalledTimes(2)

    now += PLUGIN_INSTALL_STATS_RETRY_MS - 1
    await service.getInstallCounts()
    expect(fetcher).toHaveBeenCalledTimes(2)
    warning.mockRestore()
  })

  it('keeps known counts when the site serves its empty placeholder', async () => {
    let now = NOW
    const fetcher = vi
      .fn<() => Promise<{ generatedAt: string | null; installs: Record<string, number> }>>()
      .mockResolvedValueOnce(stats(20))
      .mockResolvedValueOnce({ generatedAt: null, installs: {} })
    const service = new PluginInstallStatsService({
      pluginsDataDir: await tempRoot(),
      isFetchAllowed: () => true,
      fetcher,
      now: () => now
    })
    await service.getInstallCounts()
    await service.settled()
    now += PLUGIN_INSTALL_STATS_REFRESH_MS
    await service.getInstallCounts()
    await service.settled()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(await service.getInstallCounts()).toEqual({ 'stablyai.orca-nord-theme': 20 })
  })

  it('ignores a corrupt cache and an older snapshot', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'plugin-install-stats.json'), '{not json')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let now = NOW
    const fetcher = vi
      .fn<() => Promise<ReturnType<typeof stats>>>()
      .mockResolvedValueOnce(stats(20, '2026-10-30T02:00:00Z'))
      .mockResolvedValueOnce(stats(5, '2026-10-29T02:00:00Z'))
    const service = new PluginInstallStatsService({
      pluginsDataDir: root,
      isFetchAllowed: () => true,
      fetcher,
      now: () => now
    })
    expect(await service.getInstallCounts()).toEqual({})
    await service.settled()
    now += PLUGIN_INSTALL_STATS_REFRESH_MS
    await service.getInstallCounts()
    await service.settled()
    expect(await service.getInstallCounts()).toEqual({ 'stablyai.orca-nord-theme': 20 })
    warning.mockRestore()
  })
})

describe('parsePluginInstallStats', () => {
  it('tolerates unknown fields and drops unreadable entries', () => {
    expect(
      parsePluginInstallStats({
        schemaVersion: 1,
        generatedAt: '2026-10-31T02:15:08.771Z',
        note: 'anything',
        future: { nested: true },
        plugins: {
          'stablyai.orca-nord-theme': { installs: 37, installs30d: 37, extra: 'x' },
          'acme.bad': { installs: -1 },
          'not a key': { installs: 99 },
          'acme.text': { installs: '12' }
        }
      })
    ).toEqual({
      generatedAt: '2026-10-31T02:15:08.771Z',
      installs: { 'stablyai.orca-nord-theme': 37 }
    })
  })

  it('accepts the empty placeholder the site publishes before its first build', () => {
    expect(
      parsePluginInstallStats({ schemaVersion: 1, generatedAt: null, note: 'x', plugins: {} })
    ).toEqual({ generatedAt: null, installs: {} })
  })

  it('rejects another schema version', () => {
    expect(() =>
      parsePluginInstallStats({
        schemaVersion: 2,
        generatedAt: '2026-10-31T00:00:00Z',
        plugins: {}
      })
    ).toThrow()
  })
})

describe('fetchPluginInstallStats', () => {
  it('sends a plain bounded GET with no credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          generatedAt: '2026-10-31T00:00:00Z',
          plugins: { 'stablyai.orca-oled-theme': { installs: 82 } }
        })
      )
    )
    await expect(fetchPluginInstallStats(fetcher)).resolves.toMatchObject({
      installs: { 'stablyai.orca-oled-theme': 82 }
    })
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('https://onorca.dev/plugins/stats.json')
    expect(init?.credentials).toBe('omit')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('rejects oversized responses', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('{}', { headers: { 'content-length': String(64 * 1024 * 1024) } })
      )
    await expect(fetchPluginInstallStats(fetcher)).rejects.toThrow('size limit')
  })
})
