import { describe, expect, it } from 'vitest'
import { readHookTrustContent } from './config-toml-hook-trust-read'

const KEY = '/h/hooks.json:stop:0:0'

// Why: Codex may quote field names too; a quoted `"enabled" = false` must still read as disabled.
describe('readHookTrustContent quoted field names', () => {
  const block = `["hooks"."state"."${KEY}"]\n"trusted_hash" = "sha256:abc"\n"enabled" = false\n`

  it('reads them from a file that parses', () => {
    expect(readHookTrustContent(block).get(KEY)).toEqual({
      trustedHash: 'sha256:abc',
      enabled: false
    })
  })

  it('reads them from a file that does not parse (#22592 duplicate key)', () => {
    const broken = `model = "a"\nmodel = "b"\n\n${block}`
    expect(readHookTrustContent(broken).get(KEY)).toEqual({
      trustedHash: 'sha256:abc',
      enabled: false
    })
  })
})
