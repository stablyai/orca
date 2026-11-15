import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { STATS_METHODS } from './stats'
import { partialRuntimeStore } from '../../../orca-runtime-tests/runtime-store-partial-fixture'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const statsUsage = STATS_METHODS.find((method) => method.name === 'stats.usage')!

function callStatsUsage(runtime: OrcaRuntimeService, params: unknown) {
  return statsUsage.handler(statsUsage.params.parse(params), { runtime })
}

describe('stats.usage', () => {
  it("reads the provider's cached snapshot with the Stats & Usage pane defaults", async () => {
    const runtime = new OrcaRuntimeService(partialRuntimeStore({ getSettings: () => ({}) }))
    const reader = vi.fn(async () => ({ summary: { sessions: 3 } }))
    runtime.setUsageSnapshotReader(reader)

    await expect(callStatsUsage(runtime, { provider: 'opencode' })).resolves.toEqual({
      provider: 'opencode',
      snapshot: { summary: { sessions: 3 } }
    })
    expect(reader).toHaveBeenCalledWith('openCodeUsage', { scope: 'orca', range: '30d', limit: 10 })

    await callStatsUsage(runtime, { provider: 'codex', scope: 'all', range: '7d', sessions: 0 })
    expect(reader).toHaveBeenLastCalledWith('codexUsage', { scope: 'all', range: '7d', limit: 0 })
  })

  it('refuses on a host without the usage backend', async () => {
    const runtime = new OrcaRuntimeService(partialRuntimeStore({ getSettings: () => ({}) }))

    await expect(callStatsUsage(runtime, { provider: 'claude' })).rejects.toThrow(
      'Stats & Usage is not available on this host.'
    )
  })
})
