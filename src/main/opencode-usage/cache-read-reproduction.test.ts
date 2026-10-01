import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { parseOpenCodeUsageDatabase } from './scanner'
import {
  buildOpenCodeUsageSummary,
  buildOpenCodeUsageDailyPoints,
  buildOpenCodeUsageBreakdownRows,
  buildOpenCodeUsageRecentSessions
} from './snapshot-rollups'

it('preserves a local cache-heavy session through every usage projection', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencode-cache-read-repro-'))
  const path = join(directory, 'opencode.db')
  try {
    const db = new Database(path)
    try {
      db.exec(`CREATE TABLE session (
        id TEXT PRIMARY KEY, directory TEXT, title TEXT, model TEXT, cost REAL,
        tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
        tokens_cache_read INTEGER, time_created INTEGER, time_updated INTEGER
      )`)
      // Numeric counters captured read-only on 2026-09-18; identifying fields are synthetic.
      db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        'cache-heavy-session',
        directory,
        'Cache regression',
        JSON.stringify({ providerID: 'fixture', id: 'cache-model' }),
        0,
        13_634_611,
        207_892,
        97_467,
        264_407_020,
        1_777_777_700_000,
        1_777_777_800_000
      )
    } finally {
      db.close()
    }
    const { sessions, dailyAggregates } = await parseOpenCodeUsageDatabase(path, () => null)
    const counters = {
      inputTokens: 13_634_611,
      outputTokens: 207_892,
      reasoningOutputTokens: 97_467,
      cachedInputTokens: 264_407_020,
      totalTokens: 278_346_990
    }
    expect(sessions[0]).toMatchObject({
      totalInputTokens: counters.inputTokens,
      totalCachedInputTokens: counters.cachedInputTokens,
      totalTokens: counters.totalTokens
    })
    for (const rows of [
      dailyAggregates,
      sessions[0].locationBreakdown,
      sessions[0].modelBreakdown,
      sessions[0].locationModelBreakdown,
      buildOpenCodeUsageDailyPoints(dailyAggregates),
      buildOpenCodeUsageBreakdownRows('model', dailyAggregates, sessions),
      buildOpenCodeUsageBreakdownRows('project', dailyAggregates, sessions),
      buildOpenCodeUsageRecentSessions(sessions)
    ]) {
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject(counters)
    }
    expect(buildOpenCodeUsageSummary('all', 'all', dailyAggregates, sessions)).toMatchObject({
      ...counters,
      sessions: 1,
      events: 1,
      estimatedCostUsd: null
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
