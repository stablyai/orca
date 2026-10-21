import { describe, expect, it } from 'vitest'
import { buildMuseUsageBreakdownRows, buildMuseUsageSummary } from './snapshot-rollups'
import type { MuseUsageDailyAggregate, MuseUsageSession } from './types'

const tokens = {
  inputTokens: 100,
  cachedInputTokens: 40,
  outputTokens: 10,
  reasoningOutputTokens: 5,
  totalTokens: 110
}

function daily(
  model: string,
  projectKey: string,
  worktreeId: string | null
): MuseUsageDailyAggregate {
  return {
    day: '2026-09-22',
    model,
    projectKey,
    projectLabel: projectKey,
    repoId: worktreeId ? 'repo-1' : null,
    worktreeId,
    eventCount: 1,
    ...tokens
  }
}

// One session that ran model `a` inside the Orca worktree and model `b` outside it.
const session: MuseUsageSession = {
  sessionId: 's1',
  firstTimestamp: '2026-09-22T10:00:00.000Z',
  lastTimestamp: '2026-09-22T10:30:00.000Z',
  primaryModel: 'Mixed models',
  hasMixedModels: true,
  primaryProjectLabel: 'Multiple locations',
  hasMixedLocations: true,
  primaryWorktreeId: 'wt-1',
  primaryRepoId: 'repo-1',
  eventCount: 2,
  totalInputTokens: 200,
  totalCachedInputTokens: 80,
  totalOutputTokens: 20,
  totalReasoningOutputTokens: 10,
  totalTokens: 220,
  locationBreakdown: [
    {
      locationKey: 'worktree:wt-1',
      projectLabel: 'worktree:wt-1',
      repoId: 'repo-1',
      worktreeId: 'wt-1',
      eventCount: 1,
      ...tokens
    },
    {
      locationKey: 'cwd:/elsewhere',
      projectLabel: 'cwd:/elsewhere',
      repoId: null,
      worktreeId: null,
      eventCount: 1,
      ...tokens
    }
  ],
  modelBreakdown: [],
  locationModelBreakdown: [
    {
      locationKey: 'worktree:wt-1',
      modelKey: 'a',
      modelLabel: 'a',
      repoId: 'repo-1',
      worktreeId: 'wt-1',
      eventCount: 1,
      ...tokens
    },
    {
      locationKey: 'cwd:/elsewhere',
      modelKey: 'b',
      modelLabel: 'b',
      repoId: null,
      worktreeId: null,
      eventCount: 1,
      ...tokens
    }
  ]
}

describe('Muse usage snapshot rollups', () => {
  it('counts a session only toward models it used inside the selected scope', () => {
    const orcaRows = buildMuseUsageBreakdownRows(
      'model',
      'orca',
      [daily('a', 'worktree:wt-1', 'wt-1')],
      [session]
    )
    expect(orcaRows.map((row) => [row.key, row.sessions])).toEqual([['a', 1]])

    const allRows = buildMuseUsageBreakdownRows(
      'model',
      'all',
      [daily('a', 'worktree:wt-1', 'wt-1'), daily('b', 'cwd:/elsewhere', null)],
      [session]
    )
    expect(allRows.map((row) => [row.key, row.sessions])).toEqual([
      ['a', 1],
      ['b', 1]
    ])
  })

  it('sums token totals and picks the top model and project', () => {
    const summary = buildMuseUsageSummary(
      'all',
      '30d',
      [daily('a', 'worktree:wt-1', 'wt-1'), daily('a', 'cwd:/elsewhere', null)],
      [session]
    )
    expect(summary).toMatchObject({
      sessions: 1,
      events: 2,
      inputTokens: 200,
      cachedInputTokens: 80,
      totalTokens: 220,
      topModel: 'a',
      hasAnyMuseData: true
    })
  })
})
