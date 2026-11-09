import { describe, expect, it } from 'vitest'
import { redactString, redactValue, registerRedactedSecretValue } from './redactor'

// Credentials Orca injects into agent processes (cloud secrets, stored agent keys, GitHub tokens,
// pairing codes) must not survive any redaction pass, whatever shape the provider gives them.
const JWT_PARTS = [
  'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJpc3MiOiJnaXRodWIiLCJpbnN0YWxsYXRpb24iOjEyMzR9',
  'c2lnbmF0dXJlLWJ5dGVzLWdvLWhlcmUtX0FCQ0RFRg'
]

const TOKENS = {
  ghs: 'ghs_16C7e42F292c6912E7710c838347Ae178B4a',
  ghu: 'ghu_16C7e42F292c6912E7710c838347Ae178B4a',
  gho: 'gho_16C7e42F292c6912E7710c838347Ae178B4a',
  ghsJwt: `ghs_${'A'.repeat(36)}.${JWT_PARTS[1]}.${JWT_PARTS[2]}`,
  installationJwt: JWT_PARTS.join('.'),
  fineGrained:
    'github_pat_11ABCDEFG0123456789abc_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN',
  anthropic: `sk-ant-api03-${'x'.repeat(48)}`,
  anthropicOauth: `sk-ant-oat01-${'y'.repeat(48)}`,
  openaiProject: `sk-proj-${'z'.repeat(40)}`,
  openaiLegacy: `sk-${'q'.repeat(48)}`,
  aiGateway: 'vck_3Fz9Qk2LmN8pR4sT6uV1wX0yZaBcDeFgHiJkLmNoPq',
  vercelAccess: 'vca_9a8b7c6d5e4f3g2h1i0jKLMNOPQRSTUV',
  pairing: 'orca://pair?code=eyJ2IjoxLCJ0IjoiYWJjZGVmZ2hpamtsbW5vcCJ9'
}

describe('redactor — injected credential shapes', () => {
  for (const [name, token] of Object.entries(TOKENS)) {
    it(`removes every character of a ${name} token`, () => {
      const out = redactString(`agent failed: header=${'x'} value ${token} (end)`)
      expect(out).not.toContain(token)
      // No recoverable fragment: neither the payload nor the signature of a JWT-format token.
      for (const part of token.split(/[.?=]/).filter((p) => p.length >= 12)) {
        expect(out).not.toContain(part)
      }
      expect(out).toContain('(end)')
    })
  }

  it('tags pairing codes and GitHub tokens distinctly', () => {
    expect(redactString(`pair with ${TOKENS.pairing} now`)).toBe(
      'pair with [redacted:pairing-code] now'
    )
    expect(redactString(`t=${TOKENS.ghsJwt}`)).not.toContain(JWT_PARTS[2])
    expect(redactString(TOKENS.fineGrained)).toBe('[redacted:github-token]')
    expect(redactString(TOKENS.aiGateway)).toBe('[redacted:vercel-token]')
  })

  it('keeps non-secret placeholders and ordinary words intact', () => {
    expect(redactString('GH_TOKEN placeholder orca-ph-sbx_0123abcd')).toBe(
      'GH_TOKEN placeholder orca-ph-sbx_0123abcd'
    )
    expect(redactString('vck is a word, so is vca_short')).toBe('vck is a word, so is vca_short')
  })

  it('redacts an exact registered value of no known shape inside nested payloads', () => {
    const value = 'Zq7-custom-gateway-credential-0042'
    registerRedactedSecretValue(value)
    const out = JSON.stringify(
      redactValue({ error: { message: `spawn failed with ${value}`, argv: ['x', value] } })
    )
    expect(out).not.toContain(value)
    expect(out).toContain('[redacted:stored-key]')
  })

  it('drops env maps wholesale rather than redacting them value by value', () => {
    const out = redactValue({
      spawn: { file: 'claude', env: { CUSTOM_VALUE: 'not-a-known-shape-1234' } }
    }) as { spawn: Record<string, unknown> }
    expect(out.spawn).not.toHaveProperty('env')
    expect(out.spawn.file).toBe('claude')
  })
})
