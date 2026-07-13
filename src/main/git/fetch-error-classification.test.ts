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

  // Why: the git runner's execFile rejection prefixes `.message` with
  // `Command failed: git fetch <remote> …` and stashes git's real diagnostic in
  // `.stderr`. The classifier must read both, otherwise the multi-remote PR
  // resolver treats a missing ref as a hard failure and never walks to the
  // next remote (the original bug report's `Failed to fetch yzc/…` error).
  it('matches a missing ref carried in .stderr rather than .message', () => {
    const error = Object.assign(
      new Error(
        'Command failed: git fetch yzc +refs/heads/fix/qweather-agent-tool-port:refs/remotes/yzc/fix/qweather-agent-tool-port'
      ),
      { stderr: "fatal: couldn't find remote ref refs/heads/fix/qweather-agent-tool-port" }
    )
    expect(isMissingRemoteRefGitError(error)).toBe(true)
  })
})
