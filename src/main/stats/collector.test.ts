import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StatsEvent } from './types'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

let tempRoot: string

async function loadCollectorModule() {
  vi.resetModules()
  return await import('./collector')
}

function getStatsFile(): string {
  return join(tempRoot, 'orca-stats.json')
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'orca-stats-collector-'))
  getPathMock.mockReturnValue(tempRoot)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('StatsCollector persistence', () => {
  it('trims the event log while preserving lifetime aggregates', async () => {
    const { StatsCollector, initStatsPath } = await loadCollectorModule()
    initStatsPath()
    const collector = new StatsCollector()

    for (let index = 0; index < 1205; index++) {
      collector.record({
        type: 'agent_start',
        at: 1760000000000 + index,
        meta: { ptyId: `pty-${index}`, note: index === 700 ? 'é漢字😀'.repeat(128) : 'plain' }
      } satisfies StatsEvent)
    }

    collector.flush()

    const stats = JSON.parse(readFileSync(getStatsFile(), 'utf8'))
    expect(stats.events).toHaveLength(1000)
    expect(stats.events[0].meta.ptyId).toBe('pty-205')
    expect(stats.events.at(-1).meta.ptyId).toBe('pty-1204')
    expect(stats.aggregates.totalAgentsSpawned).toBe(1205)
    expect(stats.aggregates.firstEventAt).toBe(1760000000000)
  })

  it('does not throw from flush when stats cannot be written', async () => {
    const blockedUserDataPath = join(tempRoot, 'not-a-directory')
    writeFileSync(blockedUserDataPath, 'file blocks directory creation')
    getPathMock.mockReturnValue(blockedUserDataPath)
    const { StatsCollector, initStatsPath } = await loadCollectorModule()
    initStatsPath()
    const collector = new StatsCollector()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    collector.record({ type: 'agent_start', at: 1760000000000, meta: { ptyId: 'pty-1' } })

    expect(() => collector.flush()).not.toThrow()
    expect(errorSpy).toHaveBeenCalledWith('[stats] Failed to write stats:', expect.anything())
  })
})
