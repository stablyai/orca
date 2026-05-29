import { describe, expect, it } from 'vitest'
import { buildGitHubCheckSummary } from './github-check-summary'

describe('buildGitHubCheckSummary', () => {
  it('returns none for empty check lists', () => {
    expect(buildGitHubCheckSummary([])).toEqual({
      state: 'none',
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0
    })
  })

  it('prioritizes failed checks over pending checks', () => {
    expect(
      buildGitHubCheckSummary([
        { status: 'completed', conclusion: 'success' },
        { status: 'queued', conclusion: null },
        { status: 'completed', conclusion: 'timed_out' }
      ])
    ).toEqual({
      state: 'failure',
      total: 3,
      passed: 1,
      failed: 1,
      pending: 1
    })
  })

  it('marks all completed non-failing checks as successful', () => {
    expect(
      buildGitHubCheckSummary([
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'neutral' }
      ])
    ).toEqual({
      state: 'success',
      total: 2,
      passed: 2,
      failed: 0,
      pending: 0
    })
  })
})
