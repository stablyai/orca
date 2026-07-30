import { describe, expect, it } from 'vitest'
import { getGitHubPRSignalTone, getHostedChecksLabel } from './mobile-hosted-check-status'

describe('mobile hosted check status', () => {
  it('renders a hydrated neutral GitLab summary as unresolved checks', () => {
    const summary = {
      state: 'neutral' as const,
      total: 2,
      passed: 1,
      failed: 0,
      pending: 0,
      neutral: 1
    }
    expect(getHostedChecksLabel({ checksSummary: summary })).toBe('Unresolved checks')
    expect(getGitHubPRSignalTone({ checksSummary: summary }, 'checks')).toBe('neutral')
  })
})
