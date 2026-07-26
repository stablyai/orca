import { describe, expect, it } from 'vitest'
import {
  classifyPRRefreshError,
  safePRRefreshErrorMessage
} from './pr-refresh-error-classification'

describe('classifyPRRefreshError', () => {
  it('classifies an HTTP 429 as rate_limited even without a rate-limit body', () => {
    expect(classifyPRRefreshError(new Error('HTTP 429 Too Many Requests'))).toBe('rate_limited')
  })

  it('classifies secondary rate limit markers as rate_limited, not permission', () => {
    for (const message of [
      'You have exceeded a secondary rate limit',
      'abuse detection mechanism triggered',
      'abuse-rate-limits',
      'you have triggered an abuse detection mechanism'
    ]) {
      expect(classifyPRRefreshError(new Error(message))).toBe('rate_limited')
    }
  })

  it('classifies a 403 carrying Retry-After as rate_limited, not permission', () => {
    expect(classifyPRRefreshError(new Error('HTTP 403 Forbidden; Retry-After: 60'))).toBe(
      'rate_limited'
    )
  })

  it('classifies the primary breaker language as rate_limited', () => {
    expect(classifyPRRefreshError(new Error('API rate limit exceeded for user'))).toBe(
      'rate_limited'
    )
  })

  it('classifies a plain 403 resource denial as permission', () => {
    expect(
      classifyPRRefreshError(new Error('HTTP 403: Resource not accessible by integration'))
    ).toBe('permission')
  })

  it('classifies network failures', () => {
    for (const message of ['ETIMEDOUT', 'could not resolve host github.com', 'network is down']) {
      expect(classifyPRRefreshError(new Error(message))).toBe('network')
    }
  })

  it('classifies 404 / could not resolve repository as repo_unavailable', () => {
    expect(classifyPRRefreshError(new Error('HTTP 404 Not Found'))).toBe('repo_unavailable')
    expect(
      classifyPRRefreshError(new Error('Could not resolve to a Repository with the name'))
    ).toBe('repo_unavailable')
  })

  it('classifies an ENOENT spawn failure as gh_unavailable', () => {
    const err = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    expect(classifyPRRefreshError(err)).toBe('gh_unavailable')
    expect(classifyPRRefreshError(new Error("'gh' is not recognized as an internal command"))).toBe(
      'gh_unavailable'
    )
  })

  it('classifies auth failures after rate-limit and permission checks', () => {
    expect(classifyPRRefreshError(new Error('authentication failed: bad credentials'))).toBe('auth')
  })

  it('falls back to unknown', () => {
    expect(classifyPRRefreshError(new Error('something unexpected happened'))).toBe('unknown')
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
    // A repo/branch called "network-*" is not a connectivity failure; without a
    // structured code or a real connectivity phrase this must stay unknown.
    expect(classifyPRRefreshError(new Error('operation failed for repo acme/network-tools'))).toBe(
      'unknown'
    )
  })

  it('classifies a 404 repository error even when the message mentions network', () => {
    // 404 ranks before the network branch so the repo error is not misread.
    expect(
      classifyPRRefreshError(
        new Error('Could not resolve to a Repository named acme/network-proxy (HTTP 404)')
      )
    ).toBe('repo_unavailable')
  })

  it('classifies a 401 as auth', () => {
    expect(classifyPRRefreshError(new Error('HTTP 401 Unauthorized'))).toBe('auth')
  })

  it('classifies from the real runner error shape where the signal is on .stderr', () => {
    // Why: the runner rejects with a generic message and puts the gh diagnostic
    // on `.stderr` (string or Buffer). Reading `.message` alone would misclassify
    // these hard errors as `unknown` and treat them as transient.
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

describe('safePRRefreshErrorMessage', () => {
  it('returns non-empty copy for every classified type without leaking raw errors', () => {
    for (const type of [
      'rate_limited',
      'auth',
      'network',
      'permission',
      'repo_unavailable',
      'gh_unavailable',
      'unknown'
    ] as const) {
      const message = safePRRefreshErrorMessage(type)
      expect(message.length).toBeGreaterThan(0)
      expect(message).not.toContain('ENOENT')
    }
  })
})
