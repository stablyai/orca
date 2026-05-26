import { describe, expect, it } from 'vitest'
import { isMissingRemoteRefGitError } from './fetch-error-classification'

describe('isMissingRemoteRefGitError', () => {
  it('matches missing remote ref messages', () => {
    expect(
      isMissingRemoteRefGitError(
        new Error('fatal: could not find remote ref refs/heads/feature/test')
      )
    ).toBe(true)
    expect(
      isMissingRemoteRefGitError(
        new Error("fatal: couldn't find remote ref refs/heads/feature/test")
      )
    ).toBe(true)
  })

  it('does not match auth or network failures', () => {
    expect(isMissingRemoteRefGitError(new Error('fatal: Authentication failed'))).toBe(false)
    expect(
      isMissingRemoteRefGitError(new Error('fatal: unable to access repo: Could not resolve host'))
    ).toBe(false)
  })
})
