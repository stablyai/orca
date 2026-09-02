import { describe, expect, it } from 'vitest'
import { BUILD_IDENTITY_RE, WRITE_KEY_RE } from './telemetry-bundle-constant-patterns.mjs'

describe('telemetry bundle constant patterns', () => {
  it.each(['const', 'let', 'var'])('accepts %s declarations', (declaration) => {
    expect(`${declaration} BUILD_IDENTITY = "rc"`).toMatch(BUILD_IDENTITY_RE)
    expect(`${declaration} WRITE_KEY = "phc_example-key_123"`).toMatch(WRITE_KEY_RE)
  })

  it('rejects assignments and invalid values', () => {
    expect('BUILD_IDENTITY = "rc"').not.toMatch(BUILD_IDENTITY_RE)
    expect('const BUILD_IDENTITY = "dev"').not.toMatch(BUILD_IDENTITY_RE)
    expect('const WRITE_KEY = null').not.toMatch(WRITE_KEY_RE)
    expect('const WRITE_KEY = "example-key"').not.toMatch(WRITE_KEY_RE)
  })
})
