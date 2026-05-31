import { describe, expect, it } from 'vitest'
import { extractPairingCodeFromUrl } from './pairing'

describe('pairing deep links', () => {
  it('extracts the QR pairing code from the hash payload', () => {
    expect(extractPairingCodeFromUrl('orca://pair#abc123')).toBe('abc123')
  })

  it('extracts the pairing code from a query param', () => {
    expect(extractPairingCodeFromUrl('orca://pair?code=abc123')).toBe('abc123')
  })

  it('prefers the query pairing code when both query and hash are present', () => {
    expect(extractPairingCodeFromUrl('orca://pair?code=query-code#hash-code')).toBe('query-code')
  })

  it('ignores empty and unrelated URLs', () => {
    expect(extractPairingCodeFromUrl('orca://pair')).toBeNull()
    expect(extractPairingCodeFromUrl('https://example.com/pair#abc123')).toBeNull()
  })
})
