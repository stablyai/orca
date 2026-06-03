import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeStatsJsonFileSync } from './stats-json-writer'
import type { StatsFile } from './types'

let tempDir: string | null = null

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = null
  }
})

describe('writeStatsJsonFileSync', () => {
  it('round-trips sparse non-ASCII stats JSON without bulk UTF-8 conversion', () => {
    const sparseNonAsciiUrl = `${'a'.repeat(200_000)}ç${'a'.repeat(199_999)}`
    const stats = createStatsFile([sparseNonAsciiUrl])
    const filePath = createTempStatsPath()

    writeStatsJsonFileSync(filePath, stats)

    expect(readFileSync(filePath, 'utf-8')).toBe(JSON.stringify(stats))
  })

  it('preserves non-BMP characters across internal write buffer boundaries', () => {
    const url = `${'x'.repeat(16_383)}😀${'y'.repeat(16_383)}`
    const stats = createStatsFile([url])
    const filePath = createTempStatsPath()

    writeStatsJsonFileSync(filePath, stats)

    expect(readFileSync(filePath, 'utf-8')).toBe(JSON.stringify(stats))
  })
})

function createTempStatsPath(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'orca-stats-json-writer-'))
  return join(tempDir, 'orca-stats.json')
}

function createStatsFile(countedPRs: string[]): StatsFile {
  return {
    schemaVersion: 1,
    events: [],
    aggregates: {
      totalAgentsSpawned: 1,
      totalPRsCreated: countedPRs.length,
      totalAgentTimeMs: 0,
      countedPRs,
      firstEventAt: 1
    }
  }
}
