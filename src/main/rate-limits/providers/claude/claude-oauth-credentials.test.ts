import { describe, expect, it } from 'vitest'
import { parseClaudeOAuthCredentialsJson } from './claude-oauth-credentials'

function parse(oauth: Record<string, unknown>): ReturnType<typeof parseClaudeOAuthCredentialsJson> {
  return parseClaudeOAuthCredentialsJson(
    JSON.stringify({ claudeAiOauth: { accessToken: 'token', refreshToken: 'refresh', ...oauth } }),
    'credentials-file'
  )
}

describe('parseClaudeOAuthCredentialsJson plan', () => {
  it('names Max by the tier Claude Code saved beside it', () => {
    expect(
      parse({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' }).planType
    ).toBe('max_20x')
  })

  it('never lets the tier name or override a plan', () => {
    expect(parse({ rateLimitTier: 'default_claude_max_20x' }).planType).toBeUndefined()
    expect(
      parse({ subscriptionType: 'pro', rateLimitTier: 'default_claude_max_20x' }).planType
    ).toBe('pro')
  })

  it('keeps the token and plan when the tier is malformed', () => {
    const result = parse({ subscriptionType: 'team', rateLimitTier: { tier: 'max_20x' } })
    expect(result).toMatchObject({ token: 'token', planType: 'team' })
    expect(result.unavailable).toBeUndefined()
  })
})
