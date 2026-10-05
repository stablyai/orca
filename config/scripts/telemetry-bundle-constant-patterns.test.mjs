import { describe, expect, it } from 'vitest'
import {
  BUILD_IDENTITY_RE,
  MINIFIED_TELEMETRY_RE,
  WRITE_KEY_RE
} from './telemetry-bundle-constant-patterns.mjs'

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

  it('accepts minified adjacent declarations', () => {
    const bundle = 'var dde=`stable`,fde=`phc_example-key_123`,pde=(dde===`stable`)'
    expect(bundle).toMatch(MINIFIED_TELEMETRY_RE)
  })

  it('accepts the identity as a later declarator in a shared declaration', () => {
    const bundle = 'var wpe=!0,Tpe=`stable`,Epe=`phc_example-key_123`,Dpe=(Tpe===`stable`)'
    expect(MINIFIED_TELEMETRY_RE.exec(bundle)?.slice(1, 3)).toEqual([
      'stable',
      'phc_example-key_123'
    ])
  })

  it('rejects a minified identity with no adjacent write key', () => {
    expect('var a=!0,b=`stable`,c=null').not.toMatch(MINIFIED_TELEMETRY_RE)
  })
})
