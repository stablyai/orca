import { describe, expect, it } from 'vitest'
import { classifyPRRefreshError } from './pr-refresh-error-classification'

describe('classifyPRRefreshError', () => {
  it('classifies a 403 carrying Retry-After as rate_limited, not permission', () => {
    expect(classifyPRRefreshError(new Error('HTTP 403 Forbidden; Retry-After: 60'))).toBe(
      'rate_limited'
    )
  })

  it('does not classify a message that merely contains "author" as auth', () => {
    for (const message of [
      'PR author octocat has no write access to the fork',
      'authored 3 commits, none pushed',
      'unexpected failure from author service'
    ]) {
      expect(classifyPRRefreshError(new Error(message))).toBe('unknown')
    }
  })

  it('does not classify a repository name containing "network" as a network failure', () => {
    expect(classifyPRRefreshError(new Error('operation failed for repo acme/network-tools'))).toBe(
      'unknown'
    )
  })

  it('classifies a 404 repository error even when the message mentions network', () => {
    expect(
      classifyPRRefreshError(
        new Error('Could not resolve to a Repository named acme/network-proxy (HTTP 404)')
      )
    ).toBe('repo_unavailable')
  })

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
