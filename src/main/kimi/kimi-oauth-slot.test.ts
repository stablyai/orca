import { describe, expect, it } from 'vitest'
import { DEFAULT_KIMI_OAUTH_SLOT, parseKimiActiveOAuthSlot } from './kimi-oauth-slot'

describe('parseKimiActiveOAuthSlot', () => {
  it('returns the default slot name for the shared default key', () => {
    const config = `[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"
oauth_host = "https://auth.kimi.com"
`
    expect(parseKimiActiveOAuthSlot(config)).toBe(DEFAULT_KIMI_OAUTH_SLOT)
  })

  it('returns the scoped slot name for a mainland-cn environment', () => {
    const config = `[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code-env-0e4f99c69cc27850"
oauth_host = "https://auth.kimi.ai"
`
    expect(parseKimiActiveOAuthSlot(config)).toBe('kimi-code-env-0e4f99c69cc27850')
  })

  it.each([
    ['empty text', ''],
    ['malformed toml', 'this is [not toml'],
    ['missing providers section', '[oauth]\nkey = "oauth/kimi-code-env-abc"\n'],
    ['missing managed provider', '[providers."other".oauth]\nkey = "oauth/kimi-code-env-abc"\n'],
    ['missing oauth table', '[providers."managed:kimi-code"]\nstorage = "file"\n'],
    ['key is not a string', '[providers."managed:kimi-code".oauth]\nkey = 42\n'],
    ['key has no oauth prefix', '[providers."managed:kimi-code".oauth]\nkey = "custom-slot"\n'],
    [
      'key tries to escape the credentials dir',
      '[providers."managed:kimi-code".oauth]\nkey = "oauth/../../other"\n'
    ]
  ])('returns null for %s so callers keep the default slot', (_label: string, config: string) => {
    expect(parseKimiActiveOAuthSlot(config)).toBeNull()
  })
})
