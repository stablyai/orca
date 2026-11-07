import { describe, expect, it } from 'vitest'
import { buildUsageOverview, normalizeUsageSnapshot, USAGE_PROVIDERS } from './usage-report-model'

const scanState = (hasKey: string) => ({
  enabled: true,
  isScanning: false,
  lastScanCompletedAt: 1_000,
  [hasKey]: true
})

describe('normalizeUsageSnapshot', () => {
  it('sums Claude cache read and write into total and cache tokens', () => {
    const report = normalizeUsageSnapshot('claude', {
      scanState: scanState('hasAnyClaudeData'),
      summary: {
        sessions: 2,
        turns: 9,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 700,
        cacheWriteTokens: 150,
        estimatedCostUsd: 1.5,
        hasAnyClaudeData: true
      },
      daily: [
        {
          day: '2026-10-26',
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheWriteTokens: 4
        }
      ]
    })
    expect(report).toMatchObject({
      hasData: true,
      totalTokens: 1_000,
      newInputTokens: 100,
      cacheTokens: 850,
      activityLabel: 'turns',
      activityCount: 9,
      costUsd: 1.5
    })
    expect(report.daily).toEqual([{ day: '2026-10-26', totalTokens: 10 }])
  })

  it('treats Codex cached input as a subset of input', () => {
    const report = normalizeUsageSnapshot('codex', {
      scanState: scanState('hasAnyCodexData'),
      summary: {
        events: 4,
        inputTokens: 900,
        cachedInputTokens: 600,
        outputTokens: 100,
        totalTokens: 1_000,
        hasAnyCodexData: true
      }
    })
    expect(report).toMatchObject({
      hasData: true,
      totalTokens: 1_000,
      newInputTokens: 300,
      cacheTokens: 600,
      activityLabel: 'events'
    })
  })

  it('reads a refused or malformed snapshot as tracking off', () => {
    expect(normalizeUsageSnapshot('muse', null)).toMatchObject({
      enabled: false,
      hasData: false,
      totalTokens: 0
    })
  })
})

describe('buildUsageOverview', () => {
  it('merges days across providers and leaves cost n/a when nothing is priced', () => {
    const reports = Object.fromEntries(
      USAGE_PROVIDERS.map((id) => [id, normalizeUsageSnapshot(id, null)])
    ) as Record<(typeof USAGE_PROVIDERS)[number], ReturnType<typeof normalizeUsageSnapshot>>
    reports.claude.daily = [{ day: '2026-10-02', totalTokens: 5 }]
    reports.codex.daily = [
      { day: '2026-10-01', totalTokens: 3 },
      { day: '2026-10-02', totalTokens: 2 }
    ]
    const overview = buildUsageOverview(reports)
    expect(overview.daily.map((entry) => [entry.day, entry.totalTokens])).toEqual([
      ['2026-10-01', 3],
      ['2026-10-02', 7]
    ])
    expect(overview.activeDays).toBe(2)
    expect(overview.costUsd).toBeNull()
  })
})
