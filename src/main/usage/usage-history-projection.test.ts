import { afterEach, describe, expect, it, vi } from 'vitest'
import { aggregateClaudeUsage, mergeClaudeDailyAggregates } from '../claude-usage/usage-aggregation'
import type { ClaudeUsageAttributedTurn, ClaudeUsageDailyAggregate } from '../claude-usage/types'
import { codexUsageAggregation } from '../codex-usage/codex-usage-aggregation'
import type { CodexUsageAttributedEvent } from '../codex-usage/types'
import { parseOpenCodeUsageRow } from '../opencode-usage/opencode-usage-row-parsing'
import { projectClaudeUsageHistory, projectEventUsageHistory } from './usage-history-projection'
import { buildRecentSessions as codexSessions } from '../codex-usage/codex-usage-session-rows'
import {
  buildSummary as codexSummary,
  buildDaily as codexDaily,
  buildBreakdown as codexBreakdown
} from '../codex-usage/codex-usage-rollup-projections'
import { buildRecentSessions as claudeSessions } from '../claude-usage/claude-usage-session-rows'
import { buildSummary as claudeSummary } from '../claude-usage/claude-usage-report-aggregation'

afterEach(() => {
  vi.useRealTimers()
})

function turn(sessionId: string): ClaudeUsageAttributedTurn {
  return {
    sessionId,
    timestamp: '2026-10-24T10:00:00Z',
    day: '2026-10-24',
    model: 'claude-sonnet-5',
    cwd: '/work/folder',
    gitBranch: null,
    projectKey: 'folder',
    projectLabel: 'Folder project',
    repoId: 'folder-repo',
    worktreeId: 'folder',
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 300,
    cacheWriteTokens: 40,
    cacheWrite1hTokens: 10
  }
}

function event(sessionId: string): CodexUsageAttributedEvent {
  return {
    sessionId,
    timestamp: '2026-10-24T10:00:00Z',
    eventKey: sessionId,
    day: '2026-10-24',
    model: 'gpt-5.4',
    cwd: '/work/folder',
    projectKey: 'folder',
    projectLabel: 'Folder project',
    repoId: 'folder-repo',
    worktreeId: 'folder',
    inputTokens: 1000,
    cachedInputTokens: 900,
    outputTokens: 200,
    reasoningOutputTokens: 150,
    totalTokens: 1200,
    hasInferredPricing: false,
    longContextInputTokens: 0,
    longContextCachedInputTokens: 0,
    longContextOutputTokens: 0
  }
}

describe('historical usage projection', () => {
  it('preserves Claude session counts when daily data is absent', () => {
    const state = {
      ...aggregateClaudeUsage([turn('persisted')]),
      schemaVersion: 7,
      processedFiles: [],
      worktreeFingerprint: null,
      dailyAggregates: [],
      scanState: {
        enabled: true,
        lastScanStartedAt: null,
        lastScanCompletedAt: null,
        lastScanError: null
      }
    }
    expect(claudeSummary(state, 'all', 'all').sessions).toBe(1)
  })

  it('retains recent Claude lifetime rows when daily data is absent', () => {
    const state = {
      ...aggregateClaudeUsage([turn('persisted')]),
      schemaVersion: 7,
      processedFiles: [],
      worktreeFingerprint: null,
      dailyAggregates: [],
      scanState: {
        enabled: true,
        lastScanStartedAt: null,
        lastScanCompletedAt: null,
        lastScanError: null
      }
    }
    expect(claudeSessions(state, 'all', 'all')).toEqual([
      expect.objectContaining({ sessionId: 'persisted', inputTokens: 100, cacheReadTokens: 300 })
    ])
  })

  it('orders same-day Claude sessions by their timestamp before applying the limit', () => {
    const state = {
      ...aggregateClaudeUsage([
        { ...turn('older'), timestamp: '2026-10-24T08:00:00Z', inputTokens: 500 },
        { ...turn('newer'), timestamp: '2026-10-24T18:00:00Z', inputTokens: 10 }
      ]),
      schemaVersion: 7,
      processedFiles: [],
      worktreeFingerprint: null,
      scanState: {
        enabled: true,
        lastScanStartedAt: null,
        lastScanCompletedAt: null,
        lastScanError: null
      }
    }
    expect(claudeSessions(state, 'all', 'all', 1).map((row) => row.sessionId)).toEqual(['newer'])
  })

  it('keeps provider drilldown totals on the same days and folder scope as summaries and chart', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 24, 12))
    const scanState = {
      enabled: true,
      lastScanStartedAt: 1,
      lastScanCompletedAt: 2,
      lastScanError: null
    }
    const codex = codexUsageAggregation.aggregate([
      { ...event('multi-day'), day: '2026-10-01', timestamp: '2026-10-01T10:00:00Z' },
      event('multi-day'),
      { ...event('multi-day'), projectKey: 'external', projectLabel: 'External', worktreeId: null }
    ])
    const state = {
      ...codex,
      processedFiles: [],
      schemaVersion: 7,
      worktreeFingerprint: null,
      scanState
    }
    const summary = codexSummary(state, 'orca', '7d')
    expect(summary).toMatchObject({ totalTokens: 1200, sessions: 1, events: 1 })
    expect(codexDaily(state, 'orca', '7d').reduce((sum, row) => sum + row.totalTokens, 0)).toBe(
      1200
    )
    expect(codexSessions(state, 'orca', '7d')).toEqual([
      expect.objectContaining({
        sessionId: 'multi-day',
        lastActiveDay: '2026-10-24',
        totalTokens: 1200,
        inputTokens: 1000,
        events: 1
      })
    ])
    expect(codexBreakdown(state, 'orca', '7d', 'project')).toEqual([
      expect.objectContaining({ key: 'folder', sessions: 1, totalTokens: 1200 })
    ])

    const claude = aggregateClaudeUsage([
      { ...turn('multi-day'), day: '2026-10-01', timestamp: '2026-10-01T10:00:00Z' },
      turn('multi-day')
    ])
    const claudeState = {
      ...claude,
      processedFiles: [],
      schemaVersion: 7,
      worktreeFingerprint: null,
      scanState
    }
    expect(claudeSummary(claudeState, 'all', '7d')).toMatchObject({
      sessions: 1,
      turns: 1,
      inputTokens: 100,
      cacheReadTokens: 300
    })
    expect(claudeSessions(claudeState, 'all', '7d')).toEqual([
      expect.objectContaining({
        sessionId: 'multi-day',
        lastActiveDay: '2026-10-24',
        turns: 1,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 300,
        cacheWriteTokens: 40
      })
    ])
  })

  it('retains session identity through Claude aggregation and cross-file merges', () => {
    const first = aggregateClaudeUsage([turn('session-a'), turn('session-b')])
    const next = aggregateClaudeUsage([turn('session-a')])
    const daily = new Map<string, ClaudeUsageDailyAggregate>()
    mergeClaudeDailyAggregates(daily, first.dailyAggregates)
    mergeClaudeDailyAggregates(daily, next.dailyAggregates)
    const history = projectClaudeUsageHistory([...daily.values()])
    expect(history).toHaveLength(2)
    expect(history.find((row) => row.sessionId === 'session-a')).toMatchObject({
      totalTokens: 920,
      newInputTokens: 200,
      cacheReadTokens: 600,
      cacheWriteTokens: 80,
      inOrca: true
    })
    expect(history.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(1380)
    expect(history.every((row) => row.apiEquivalentCostUsd !== null)).toBe(true)
  })

  it('counts Codex input and output once and keeps cache/reasoning as subsets', () => {
    const daily = codexUsageAggregation.aggregate([event('a'), event('b')]).dailyAggregates
    const history = projectEventUsageHistory('codex', daily)
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({
      newInputTokens: 100,
      cacheReadTokens: 900,
      outputTokens: 200,
      reasoningTokens: 150,
      totalTokens: 1200
    })
    expect(history.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(2400)
    expect(history[0]?.apiEquivalentCostUsd).toBeGreaterThan(0)
  })

  it('keeps missing model pricing and legacy session attribution unavailable', () => {
    const daily = codexUsageAggregation.aggregate([{ ...event('a'), model: null }]).dailyAggregates
    const history = projectEventUsageHistory(
      'codex',
      daily.map(({ sessionId: _session, ...row }) => row)
    )
    expect(history[0]).toMatchObject({
      apiEquivalentCostUsd: null,
      sessionId: null,
      totalTokens: 1200
    })
  })

  it('normalizes OpenCode read/write caches and separate reasoning without claiming telemetry is billed', () => {
    const parsed = parseOpenCodeUsageRow({
      id: 'message',
      session_id: 'session',
      time_created: 1_792_836_000_000,
      time_updated: null,
      directory: '/work/folder',
      title: null,
      worktree: null,
      session_model: null,
      data: JSON.stringify({
        cost: 25,
        tokens: {
          total: 1000,
          input: 100,
          output: 200,
          reasoning: 50,
          cache: { read: 400, write: 80 }
        }
      })
    })
    expect(parsed).not.toBeNull()
    if (!parsed) {
      throw new Error('Expected fixture usage')
    }
    const history = projectEventUsageHistory('opencode', [
      {
        ...parsed,
        day: '2026-10-24',
        projectKey: 'folder',
        projectLabel: 'Folder',
        repoId: null,
        worktreeId: 'folder',
        eventCount: 1
      }
    ])
    expect(history[0]).toMatchObject({
      newInputTokens: 100,
      cacheReadTokens: 400,
      cacheWriteTokens: 80,
      outputTokens: 250,
      totalTokens: 1000,
      apiEquivalentCostUsd: null
    })
  })
})
