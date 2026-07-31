import { describe, expect, it } from 'vitest'
import { buildGitHubCheckSummary } from './github-check-summary'
import { buildGitLabCheckSummary } from './gitlab-check-summary'

describe('buildGitHubCheckSummary', () => {
  it('returns none for empty check lists', () => {
    expect(buildGitHubCheckSummary([])).toEqual({
      state: 'none',
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      neutral: 0
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
      pending: 1,
      neutral: 0
    })
  })

  it('keeps neutral and unknown terminal conclusions out of passed', () => {
    expect(
      buildGitHubCheckSummary([
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'neutral' }
      ])
    ).toEqual({
      state: 'neutral',
      total: 2,
      passed: 1,
      failed: 0,
      pending: 0,
      neutral: 1
    })
  })

  it('rolls up GitLab jobs with unknown terminal statuses as neutral', () => {
    expect(buildGitLabCheckSummary([{ status: 'success' }, { status: 'future_status' }])).toEqual({
      state: 'neutral',
      total: 2,
      passed: 1,
      failed: 0,
      pending: 0,
      neutral: 1
    })
  })
})
