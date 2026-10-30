import { expect, it } from 'vitest'
import { buildOmpUsageRecentSessions } from './snapshot-rollups'
import type { OmpUsageSession } from './types'

function session(overrides: Partial<OmpUsageSession> & { sessionId: string }): OmpUsageSession {
  return {
    startedAt: '2026-10-01T10:00:00.000Z',
    cwd: '/repo/worktree',
    model: 'gpt-5.6-sol',
    provider: 'openai',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 2,
    totalTokens: 15,
    costUsd: 0.01,
    ...overrides
  }
}

it('orders recent sessions by last activity, not by session start, then applies the limit', () => {
  const rows = buildOmpUsageRecentSessions(
    [
      session({
        sessionId: 'old',
        startedAt: '2026-10-01T09:00:00.000Z',
        endedAt: '2026-10-01T09:30:00.000Z'
      }),
      session({
        sessionId: 'newer-start',
        startedAt: '2026-10-02T09:00:00.000Z',
        endedAt: '2026-10-02T09:10:00.000Z'
      }),
      session({
        sessionId: 'long-running',
        startedAt: '2026-10-01T08:00:00.000Z',
        endedAt: '2026-10-03T08:00:00.000Z'
      }),
      session({ sessionId: 'unfinished', startedAt: '2026-10-02T12:00:00.000Z' })
    ],
    2
  )

  expect(rows.map((row) => row.sessionId)).toEqual(['long-running', 'unfinished'])
  expect(rows[0]?.lastActiveAt).toBe('2026-10-03T08:00:00.000Z')
  expect(rows[0]?.durationMinutes).toBe(2 * 24 * 60)
})
