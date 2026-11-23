import { expect, it } from 'vitest'
import type { ClaudeUsageDailyAggregate, ClaudeUsagePersistedState } from './types'
import { buildSummary } from './claude-usage-report-aggregation'

function dailyRow(day: string, model: string): ClaudeUsageDailyAggregate {
  return {
    day,
    model,
    projectKey: 'project',
    projectLabel: 'project',
    repoId: null,
    worktreeId: 'worktree-1',
    turnCount: 1,
    zeroCacheReadTurnCount: 0,
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0
  }
}

function stateWithDaily(dailyAggregates: ClaudeUsageDailyAggregate[]): ClaudeUsagePersistedState {
  return {
    schemaVersion: 6,
    worktreeFingerprint: null,
    processedFiles: [],
    sessions: [],
    dailyAggregates,
    scanState: {
      enabled: true,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null
    }
  }
}

it('ranks Claude top model and project by all displayed token buckets', () => {
  const cacheHeavy = {
    ...dailyRow('2026-10-24', 'cache-heavy'),
    projectKey: 'cached',
    projectLabel: 'Cached project',
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 4_000_000
  }
  const state = stateWithDaily([dailyRow('2026-10-24', 'input-heavy'), cacheHeavy])
  expect(buildSummary(state, 'all', 'all')).toMatchObject({
    topModel: 'cache-heavy',
    topProject: 'Cached project'
  })
})
