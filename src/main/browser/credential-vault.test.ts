import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
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
    // Why: POSIX mode bits don't exist on Windows; guard so the assertion only
    // runs on platforms where the 0600 restriction is meaningful.
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'creds.json')).mode & 0o777).toBe(0o600)
    }
    const reopened = makeVault()
    expect(reopened.matchesForOrigin('https://github.com').length).toBe(1)
  })

  it('refuses to save when encryption is unavailable', () => {
    const vault = makeVault(false)
    expect(vault.status().available).toBe(false)
    expect(
      vault.save({ origin: 'https://github.com', username: 'me', password: 'x' }).entry
    ).toBeNull()
    // Fix C: no vault file should have been written to disk
    expect(() => readFileSync(join(dir, 'creds.json'), 'utf-8')).toThrow()
  })

  it('update() does not corrupt state when encryption is unavailable', () => {
    // Fix D: regression test for Fix A — cache must stay coherent when
    // encryption is unavailable mid-update.
    const filePath = join(dir, 'creds.json')

    // Create the entry with encryption available.
    const xor = (s: string): Buffer =>
      Buffer.from(
        s
          .split('')
          .map((c) => String.fromCharCode(c.charCodeAt(0) ^ 7))
          .join(''),
        'binary'
      )
    const vaultAvailable = new BrowserCredentialVault({
      filePath,
      encryptionAvailable: () => true,
      encrypt: (p) => xor(p),
      decrypt: (b) => xor(b.toString('binary')).toString('binary'),
      now: () => 1000,
      generateId: () => `id-${(counter += 1)}`
    })
    const { entry } = vaultAvailable.save({
      origin: 'https://example.com',
      username: 'original',
      password: 'secret'
    })
    const id = entry!.id

    // Now construct a second vault over the same file with encryption unavailable.
    const vaultUnavailable = new BrowserCredentialVault({
      filePath,
      encryptionAvailable: () => false,
      encrypt: (p) => xor(p),
      decrypt: (b) => xor(b.toString('binary')).toString('binary'),
      now: () => 2000,
      generateId: () => `id-${(counter += 1)}`
    })
    const result = vaultUnavailable.update({ id, username: 'new', password: 'x' })
    expect(result).toBeNull()

    // A fresh vault reading the same file must see the ORIGINAL username —
    // neither the in-memory cache nor the file on disk should have been mutated.
    const reopened = new BrowserCredentialVault({
      filePath,
      encryptionAvailable: () => true,
      encrypt: (p) => xor(p),
      decrypt: (b) => xor(b.toString('binary')).toString('binary'),
      now: () => 3000,
      generateId: () => `id-${(counter += 1)}`
    })
    const matches = reopened.matchesForOrigin('https://example.com')
    expect(matches).toHaveLength(1)
    expect(matches[0].username).toBe('original')
  })

  it('rejects invalid origins', () => {
    const vault = makeVault()
    expect(vault.save({ origin: 'about:blank', username: 'me', password: 'x' }).entry).toBeNull()
  })
})

describe('BrowserCredentialVault.importMany', () => {
  it('adds new, skips existing host+user, counts invalid, and flushes once', () => {
    const vault = makeVault()
    vault.save({ origin: 'https://github.com', username: 'me', password: 'old' })
    const summary = vault.importMany([
      { origin: 'https://github.com', username: 'me', password: 'DIFFERENT' }, // skip (exists)
      { origin: 'https://gitlab.com', username: 'me', password: 'pw' }, // add
      { origin: 'about:blank', username: 'x', password: 'y' }, // invalid origin
      { origin: 'https://x.com', username: '', password: 'y' } // invalid empty user
    ])
    expect(summary).toEqual({ added: 1, skipped: 1, invalid: 2 })
    // skip-existing must NOT overwrite the stored password
    const id = vault.matchesForOrigin('https://github.com')[0].id
    expect(vault.reveal(id)).toBe('old')
    expect(vault.matchesForOrigin('https://gitlab.com').length).toBe(1)
  })

  it('writes nothing when encryption is unavailable', () => {
    const vault = makeVault(false)
    expect(vault.importMany([{ origin: 'https://x.com', username: 'a', password: 'b' }])).toEqual({
      added: 0,
      skipped: 0,
      invalid: 1
    })
    expect(() => readFileSync(join(dir, 'creds.json'), 'utf-8')).toThrow()
  })
})
