import { describe, expect, it } from 'vitest'
import type { ClaudeUsageDailyAggregate, ClaudeUsagePersistedState } from './types'
import { buildBreakdown, buildSummary } from './claude-usage-report-aggregation'

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

describe('buildSummary unpriced models', () => {
  it('keeps the priced total and flags the rows it had to leave out', () => {
    const summary = buildSummary(
      stateWithDaily([
        dailyRow('2026-10-15', 'claude-sonnet-5-5'),
        dailyRow('2026-10-15', 'claude-opus-9')
      ]),
      'all',
      'all'
    )

    expect(summary.estimatedCostUsd).toBeCloseTo(12)
    expect(summary.hasUnpricedModels).toBe(true)
  })
})

describe('buildSummary Haiku 5.5 long-context requests', () => {
  it('bills only the requests recorded over 100K at the long-context rates', () => {
    const row = {
      ...dailyRow('2026-10-15', 'claude-haiku-5-5'),
      longContext: {
        inputTokens: 500_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0
      }
    }
    const state = stateWithDaily([row])

    expect(buildSummary(state, 'all', 'all').estimatedCostUsd).toBeCloseTo(0.8)
    expect(buildSummary(state, 'all', 'all').hasUnpricedModels).toBe(false)
    expect(buildBreakdown(state, 'all', 'all', 'model')[0]?.estimatedCostUsd).toBeCloseTo(0.8)
  })
})
