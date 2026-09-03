import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getActiveClaudeService } from './keychain'

/**
 * The CLI derives its scoped Keychain service from sha256 over the NFC-normalized
 * CLAUDE_CONFIG_DIR literal. macOS surfaces decomposed (NFD) paths, so an un-normalized
 * hash names an item the CLI never reads — and a missing item fails over to the file
 * with no error, which is a silent sign-out rather than a visible failure.
 */
describe('scoped Claude Keychain service naming', () => {
  const nfd = '/Users/tester/orca-qa/José/auth' // e + combining acute
  const nfc = nfd.normalize('NFC')

  it('normalizes the hash input to NFC so composed and decomposed paths agree', () => {
    expect(nfd).not.toBe(nfc)
    expect(getActiveClaudeService(nfd)).toBe(getActiveClaudeService(nfc))
  })

  it('matches sha256(NFC(literal)) exactly, the derivation the CLI uses', () => {
    const expected = createHash('sha256').update(nfc, 'utf8').digest('hex').slice(0, 8)
    expect(getActiveClaudeService(nfd)).toBe(`Claude Code-credentials-${expected}`)
  })

  it('hashes the literal as given — no resolve, no tilde expansion, no trailing-slash strip', () => {
    expect(getActiveClaudeService('/a/b')).not.toBe(getActiveClaudeService('/a/b/'))
    expect(getActiveClaudeService('~/x')).not.toBe(getActiveClaudeService('/root/x'))
  })
})
