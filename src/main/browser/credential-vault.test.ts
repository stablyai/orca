import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserCredentialVault, type CredentialVaultDeps } from './credential-vault'

let dir: string
let counter: number

function makeVault(available = true): BrowserCredentialVault {
  // Why: a reversible XOR stands in for safeStorage so round-trips are testable
  // without an OS keyring; production injects the real safeStorage funcs.
  const xor = (s: string): Buffer =>
    Buffer.from(
      s
        .split('')
        .map((c) => String.fromCharCode(c.charCodeAt(0) ^ 7))
        .join(''),
      'binary'
    )
  const deps: CredentialVaultDeps = {
    filePath: join(dir, 'creds.json'),
    encryptionAvailable: () => available,
    encrypt: (p) => xor(p),
    decrypt: (b) => xor(b.toString('binary')).toString('binary'),
    now: () => 1000,
    generateId: () => `id-${(counter += 1)}`
  }
  return new BrowserCredentialVault(deps)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-vault-'))
  counter = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('BrowserCredentialVault', () => {
  it('saves a new credential and matches it by origin, without exposing the password', () => {
    const vault = makeVault()
    const { outcome, entry } = vault.save({
      origin: 'https://github.com',
      username: 'me',
      password: 'pw1'
    })
    expect(outcome).toBe('created')
    expect(entry?.username).toBe('me')
    expect(JSON.stringify(entry)).not.toContain('pw1')
    const matches = vault.matchesForOrigin('https://github.com/login')
    expect(matches.map((m) => m.username)).toEqual(['me'])
  })

  it('reveals the stored password via decrypt', () => {
    const vault = makeVault()
    const { entry } = vault.save({ origin: 'https://github.com', username: 'me', password: 'pw1' })
    expect(vault.reveal(entry!.id)).toBe('pw1')
  })

  it('reports updated when the password changes for an existing username', () => {
    const vault = makeVault()
    vault.save({ origin: 'https://github.com', username: 'me', password: 'pw1' })
    expect(
      vault.save({ origin: 'https://github.com', username: 'me', password: 'pw2' }).outcome
    ).toBe('updated')
    expect(
      vault.save({ origin: 'https://github.com', username: 'me', password: 'pw2' }).outcome
    ).toBe('unchanged')
  })

  it('persists across instances and writes the file 0600 without plaintext', () => {
    const vault = makeVault()
    vault.save({ origin: 'https://github.com', username: 'me', password: 'secret' })
    const raw = readFileSync(join(dir, 'creds.json'), 'utf-8')
    expect(raw).not.toContain('secret')
    const reopened = makeVault()
    expect(reopened.matchesForOrigin('https://github.com').length).toBe(1)
  })

  it('refuses to save when encryption is unavailable', () => {
    const vault = makeVault(false)
    expect(vault.status().available).toBe(false)
    expect(
      vault.save({ origin: 'https://github.com', username: 'me', password: 'x' }).entry
    ).toBeNull()
  })

  it('rejects invalid origins', () => {
    const vault = makeVault()
    expect(vault.save({ origin: 'about:blank', username: 'me', password: 'x' }).entry).toBeNull()
  })
})
