import { describe, expect, it } from 'vitest'
import type { ClaudeUsageDailyAggregate } from '../claude-usage/types'
import type { CodexUsageDailyAggregate } from '../codex-usage/types'
import { buildToknSyncRows } from './tokn-sync-rows'

function claudeDay(overrides: Partial<ClaudeUsageDailyAggregate>): ClaudeUsageDailyAggregate {
  return {
    day: '2026-11-02',
    model: 'claude-sonnet-4-5-20250929',
    projectKey: 'repo-a',
    projectLabel: 'repo-a',
    repoId: 'repo-a',
    worktreeId: 'wt-a',
    turnCount: 2,
    zeroCacheReadTurnCount: 0,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 1000,
    cacheWriteTokens: 300,
    cacheWrite1hTokens: 200,
    ...overrides
  }
}

const CODEX_DAY: CodexUsageDailyAggregate = {
  day: '2026-11-02',
  model: 'openai/gpt-5-codex',
  projectKey: 'repo-b',
  projectLabel: 'repo-b',
  repoId: 'repo-b',
  worktreeId: null,
  eventCount: 3,
  inputTokens: 1000,
  cachedInputTokens: 600,
  outputTokens: 200,
  reasoningOutputTokens: 50,
  totalTokens: 1200,
  hasInferredPricing: false,
  longContextInputTokens: 0,
  longContextCachedInputTokens: 0,
  longContextOutputTokens: 0
}

describe('buildToknSyncRows', () => {
  it('merges projects into tokn day totals with the CLI model ids and cache tiers', () => {
    const rows = buildToknSyncRows({
      claude: [
        claudeDay({}),
        claudeDay({ projectKey: 'repo-c', projectLabel: 'repo-c', worktreeId: null }),
        claudeDay({ model: '<synthetic>' })
      ],
      codex: [CODEX_DAY]
    })

    expect(rows.map(({ costUsd: _cost, ...row }) => row)).toEqual([
      {
        day: '2026-11-02',
        tool: 'claude-code',
        model: 'claude-sonnet-4-5',
        requests: 4,
        input: 200,
        output: 100,
        cacheWrite5m: 200,
        cacheWrite1h: 400,
        cacheRead: 2000,
        fast: false
      },
      {
        day: '2026-11-02',
        tool: 'codex',
        model: 'gpt-5-codex',
        requests: 3,
        input: 400,
        output: 200,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 600,
        fast: false
      }
    ])
  })
})
