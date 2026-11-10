import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  PLUGIN_INSTALL_STATS_REFRESH_MS,
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
