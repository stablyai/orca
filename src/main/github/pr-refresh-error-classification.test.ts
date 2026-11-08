import { describe, expect, it } from 'vitest'
import { classifyPRRefreshError } from './pr-refresh-error-classification'

describe('classifyPRRefreshError', () => {
  it('classifies from the real runner error shape where the signal is on .stderr', () => {
    // The runner stores diagnostics on stderr even when message is only a generic exit error.
    const permission = Object.assign(new Error('gh exited with 1.'), {
      stderr: 'HTTP 403: Resource not accessible by integration'
    })
    expect(classifyPRRefreshError(permission)).toBe('permission')

    const repo = Object.assign(new Error('gh exited with 1.'), {
      stderr: Buffer.from('HTTP 404: Not Found')
    })
    expect(classifyPRRefreshError(repo)).toBe('repo_unavailable')

    const secondary = Object.assign(new Error('gh exited with 1.'), {
      stderr: 'You have exceeded a secondary rate limit'
    })
    expect(classifyPRRefreshError(secondary)).toBe('rate_limited')

    const auth = Object.assign(new Error('gh exited with 1.'), {
      stdout: '',
      stderr: 'gh auth login required: bad credentials'
    })
    expect(classifyPRRefreshError(auth)).toBe('auth')
  })
})
