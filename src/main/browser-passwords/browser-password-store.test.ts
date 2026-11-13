import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secret-store'
import { BrowserPasswordStore } from './browser-password-store'

const SEAL_PREFIX = 'sealed:'

function installFakeSecretStore(options: { gap?: string | null; available?: boolean } = {}): void {
  setSecretStore({
    isEncryptionAvailable: () => options.available ?? true,
    // Reversible but not plaintext, so a test can tell sealed bytes from raw ones.
    encryptString: (plain) => Buffer.from(SEAL_PREFIX + Buffer.from(plain).toString('hex')),
    decryptString: (cipher) => {
      const text = cipher.toString()
      if (!text.startsWith(SEAL_PREFIX)) {
        throw new Error('not sealed by this store')
      }
      return Buffer.from(text.slice(SEAL_PREFIX.length), 'hex').toString()
    },
    describeProtectionGap: () => options.gap ?? null
  })
}

describe('BrowserPasswordStore', () => {
  let dir: string
  let filePath: string
  let clock: number
  const newStore = (): BrowserPasswordStore =>
    new BrowserPasswordStore(filePath, { now: () => clock })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-browser-passwords-test-'))
    filePath = join(dir, 'vault.json')
    clock = 1000
    installFakeSecretStore()
  })

  afterEach(() => {
    _resetSecretStoreForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips entries and passwords through a fresh instance, sealed on disk', () => {
    const added = newStore().add({
      origin: 'https://Example.com/login?next=1',
      username: 'alice@example.com',
      password: 'hunter2'
    })
    expect(added.ok && added.value.created).toBe(true)
    expect(newStore().addNever('http://never.test/path').ok).toBe(true)

    const onDisk = readFileSync(filePath, 'utf8')
    expect(onDisk).not.toContain('alice')
    expect(onDisk).not.toContain('example.com')
    expect(onDisk).not.toContain('hunter2')
    expect(JSON.parse(onDisk)).toMatchObject({ version: 1, format: 'orca-browser-passwords-v1' })

    const reopened = newStore()
    const list = reopened.list()
    expect(list).toEqual({
      ok: true,
      value: [
        {
          id: expect.any(String),
          origin: 'https://example.com',
          username: 'alice@example.com',
          createdAt: 1000,
          updatedAt: 1000,
          lastUsedAt: null
        }
      ]
    })
    const id = list.ok ? list.value[0].id : ''
    expect(reopened.getPassword(id)).toEqual({ ok: true, value: 'hunter2' })
    expect(reopened.listNever()).toEqual({ ok: true, value: ['http://never.test'] })
    expect(reopened.isNever('http://never.test/other')).toEqual({ ok: true, value: true })
    expect(reopened.isNever('https://never.test')).toEqual({ ok: true, value: false })
    expect(reopened.removeNever('http://never.test').ok).toBe(true)
    expect(newStore().listNever()).toEqual({ ok: true, value: [] })
  })

  it('never overwrites a vault it cannot unseal', () => {
    newStore().add({ origin: 'https://a.test', username: 'u', password: 'p' })
    const before = readFileSync(filePath, 'utf8')
    // A different key: the same file no longer unseals.
    setSecretStore({
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(plain),
      decryptString: () => {
        throw new Error('wrong key')
      },
      describeProtectionGap: () => null
    })
    const store = newStore()
    expect(store.availability().available).toBe(false)
    expect(store.add({ origin: 'https://b.test', username: 'u', password: 'p' }).ok).toBe(false)
    expect(store.addNever('https://b.test').ok).toBe(false)
    expect(readFileSync(filePath, 'utf8')).toBe(before)
  })

  it('never overwrites a corrupt vault', () => {
    writeFileSync(filePath, '{"version":1,"format":"orca-browser-passwords-v1","index":')
    expect(newStore().add({ origin: 'https://a.test', username: 'u', password: 'p' }).ok).toBe(
      false
    )
    expect(readFileSync(filePath, 'utf8')).toBe(
      '{"version":1,"format":"orca-browser-passwords-v1","index":'
    )
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'never overwrites a vault it is denied reading',
    () => {
      newStore().add({ origin: 'https://a.test', username: 'u', password: 'p' })
      const before = readFileSync(filePath, 'utf8')
      chmodSync(filePath, 0o000)
      try {
        const store = newStore()
        expect(store.list()).toEqual({
          ok: false,
          reason: 'unavailable',
          message: 'Saved passwords exist but could not be read.'
        })
        expect(store.add({ origin: 'https://b.test', username: 'u', password: 'p' }).ok).toBe(false)
      } finally {
        chmodSync(filePath, 0o600)
      }
      expect(readFileSync(filePath, 'utf8')).toBe(before)
    }
  )

  it('refuses a password copied under another entry in the file', () => {
    const store = newStore()
    const bank = store.add({ origin: 'https://bank.test', username: 'u', password: 'bank-pw' })
    const evil = store.add({ origin: 'https://evil.test', username: 'u', password: 'evil-pw' })
    const bankId = bank.ok ? bank.value.entry.id : ''
    const evilId = evil.ok ? evil.value.entry.id : ''
    const file = JSON.parse(readFileSync(filePath, 'utf8'))
    file.passwords[evilId] = file.passwords[bankId]
    writeFileSync(filePath, JSON.stringify(file))

    const reopened = newStore()
    expect(reopened.getPassword(evilId)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(reopened.getPassword(bankId)).toEqual({ ok: true, value: 'bank-pw' })
  })
})
