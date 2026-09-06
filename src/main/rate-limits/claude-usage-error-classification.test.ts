import { describe, expect, it } from 'vitest'
import {
  classifyClaudeCredentialAbsence,
  classifyClaudeOAuthUsageError
} from './claude-usage-error-classification'
import { OAuthUsageError, OAuthUsageUnreadableError } from './claude-oauth-usage-error'

describe('classifyClaudeOAuthUsageError', () => {
  // Why: a 200 that yielded no window is a read failure, not a usage answer. 'parse' is the kind
  // the status-bar copy reads to keep the internal diagnostic out of the tooltip, and the CLI
  // fallback is what can still produce a real reading.
  it('classifies an unreadable usage body as a parse failure that may retry via the CLI', () => {
    expect(
      classifyClaudeOAuthUsageError(new OAuthUsageUnreadableError('no usage window'))
    ).toMatchObject({
      failureKind: 'parse',
      shouldAttemptCliFallback: true,
      shouldAttemptDelegatedRefresh: false,
      terminal: false
    })
  })

  it('treats OAuth unauthorized as stale-token repair/fallback', () => {
    expect(
      classifyClaudeOAuthUsageError(new OAuthUsageError('Invalid OAuth token', 401, true))
    ).toMatchObject({
      failureKind: 'stale-token',
      shouldAttemptDelegatedRefresh: true,
      shouldAttemptCliFallback: true,
      terminal: false
    })
  })

  it('keeps usage rate limits terminal', () => {
    expect(
      classifyClaudeOAuthUsageError(new OAuthUsageError('Claude usage is rate limited', 429, true))
    ).toMatchObject({
      failureKind: 'rate-limited',
      shouldAttemptDelegatedRefresh: false,
      shouldAttemptCliFallback: false,
      terminal: true
    })
  })

  it('classifies missing OAuth scope as actionable terminal state', () => {
    expect(
      classifyClaudeOAuthUsageError(
        new OAuthUsageError("missing required scope 'user:profile'", 403, true)
      )
    ).toMatchObject({
      failureKind: 'missing-scope',
      terminal: true
    })
  })

  it('allows CLI fallback for network-shaped failures', () => {
    expect(classifyClaudeOAuthUsageError(new Error('fetch failed: ENOTFOUND'))).toMatchObject({
      failureKind: 'network',
      shouldAttemptCliFallback: true,
      shouldAttemptDelegatedRefresh: false
    })
  })
})

describe('classifyClaudeCredentialAbsence', () => {
  it('classifies refresh-only credentials as repairable', () => {
    expect(classifyClaudeCredentialAbsence({ hasRefreshableCredentials: true })).toMatchObject({
      failureKind: 'refreshable-credentials-without-token',
      shouldAttemptDelegatedRefresh: true,
      shouldAttemptCliFallback: true
    })
  })

  it('classifies Keychain read failures separately from missing credentials', () => {
    expect(
      classifyClaudeCredentialAbsence({
        hasRefreshableCredentials: false,
        keychainUnavailable: true
      })
    ).toMatchObject({
      failureKind: 'keychain-unavailable',
      shouldAttemptCliFallback: true,
      shouldAttemptDelegatedRefresh: false
    })
  })

  it('classifies live Claude ownership as a deferred state', () => {
    expect(
      classifyClaudeCredentialAbsence({
        hasRefreshableCredentials: true,
        managedRefreshDeferredByLivePty: true
      })
    ).toMatchObject({
      failureKind: 'deferred-by-live-session',
      terminal: true
    })
  })
})
