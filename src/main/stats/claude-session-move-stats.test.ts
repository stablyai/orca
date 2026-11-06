import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initStatsPath, StatsCollector } from './collector'

const directories: string[] = []

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number'
}

function readSavedMoves(file: string): {
  totalAgentsSpawned: number | null
  claudeSessionMoves: { resume: number; proxy: number; rebalances: number; failures: number }
} {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!isRecord(parsed) || !isRecord(parsed.aggregates)) {
    throw new Error('orca-stats.json has no aggregates')
  }
  const moves = parsed.aggregates.claudeSessionMoves
  if (
    !isRecord(moves) ||
    !isCount(moves.resume) ||
    !isCount(moves.proxy) ||
    !isCount(moves.rebalances) ||
    !isCount(moves.failures)
  ) {
    throw new Error('orca-stats.json is missing claudeSessionMoves')
  }
  const totalAgentsSpawned = parsed.aggregates.totalAgentsSpawned
  return {
    totalAgentsSpawned: isCount(totalAgentsSpawned) ? totalAgentsSpawned : null,
    claudeSessionMoves: {
      resume: moves.resume,
      proxy: moves.proxy,
      rebalances: moves.rebalances,
      failures: moves.failures
    }
  }
}

function collectorFrom(existing?: string): { stats: StatsCollector; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-move-stats-'))
  directories.push(dir)
  const file = join(dir, 'orca-stats.json')
  if (existing !== undefined) {
    writeFileSync(file, existing)
  }
  initStatsPath(dir)
  return { stats: new StatsCollector(), file }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('claude session move stats', () => {
  it('counts landed moves by strategy, rebalances, and failures', () => {
    const { stats, file } = collectorFrom()
    stats.recordClaudeSessionMove({ strategy: 'proxy', rebalance: true, failed: false })
    stats.recordClaudeSessionMove({ strategy: 'resume', rebalance: false, failed: false })
    stats.recordClaudeSessionMove({ strategy: 'resume', rebalance: false, failed: true })
    stats.flush()
    expect(readSavedMoves(file).claudeSessionMoves).toEqual({
      resume: 1,
      proxy: 1,
      rebalances: 1,
      failures: 1
    })
  })

  it('keeps older stats files and fills missing move counters with zero', () => {
    const { stats, file } = collectorFrom(
      JSON.stringify({
        schemaVersion: 1,
        events: [],
        aggregates: {
          totalAgentsSpawned: 4,
          totalPRsCreated: 1,
          totalAgentTimeMs: 9,
          countedPRs: [],
          firstEventAt: 3,
          claudeSessionMoves: { resume: 2 }
        }
      })
    )
    stats.recordClaudeSessionMove({ strategy: 'proxy', rebalance: false, failed: false })
    stats.flush()
    const saved = readSavedMoves(file)
    expect(saved.totalAgentsSpawned).toBe(4)
    expect(saved.claudeSessionMoves).toEqual({
      resume: 2,
      proxy: 1,
      rebalances: 0,
      failures: 0
    })
  })
})
