import { describe, expect, it } from 'vitest'
import { classifyClaudeOAuthUsageError } from './claude-usage-error-classification'
import { ClaudeUsageRequestError, OAuthUsageError } from './claude-oauth-usage-error'

describe('classifyClaudeOAuthUsageError', () => {
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
    expect(
      classifyClaudeOAuthUsageError(
        new ClaudeUsageRequestError(new Error('fetch failed: ENOTFOUND'))
      )
    ).toMatchObject({
      failureKind: 'network',
      shouldAttemptCliFallback: true,
      shouldAttemptDelegatedRefresh: false
    })
  })

  it("classifies Electron's proxy failure as network and a malformed body as parse", () => {
    expect(
      classifyClaudeOAuthUsageError(
        new ClaudeUsageRequestError(new Error('net::ERR_PROXY_CONNECTION_FAILED'))
      ).failureKind
    ).toBe('network')
    expect(
      classifyClaudeOAuthUsageError(
        new ClaudeUsageRequestError(new SyntaxError('Unexpected token'))
      ).failureKind
    ).toBe('parse')
  })

  it('leaves an error from mapping a response unclassified', () => {
    expect(
      classifyClaudeOAuthUsageError(
        new TypeError("Cannot read properties of null (reading 'five_hour')")
      ).failureKind
    ).toBe('unknown')
  })
})
