import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  it('updates the password instead of adding when origin and username already exist', () => {
    const store = newStore()
    const first = store.add({ origin: 'https://a.test', username: 'u', password: 'one' })
    clock = 2000
    const second = store.add({ origin: 'https://a.test/x', username: 'u', password: 'two' })
    const third = store.add({ origin: 'https://a.test', username: 'other', password: 'three' })
    expect(second.ok && second.value.created).toBe(false)
    expect(third.ok && third.value.created).toBe(true)
    const firstId = first.ok ? first.value.entry.id : ''
    expect(second.ok && second.value.entry).toMatchObject({
      id: firstId,
      createdAt: 1000,
      updatedAt: 2000
    })
    expect(newStore().getPassword(firstId)).toEqual({ ok: true, value: 'two' })
    const list = newStore().list()
    expect(list.ok && list.value).toHaveLength(2)
  })

  it('rejects non-web origins and empty passwords', () => {
    const store = newStore()
    expect(store.add({ origin: 'file:///x', username: 'u', password: 'p' })).toEqual({
      ok: false,
      reason: 'invalid-origin'
    })
    expect(store.add({ origin: 'https://a.test', username: 'u', password: '' })).toEqual({
      ok: false,
      reason: 'invalid-password'
    })
    expect(existsSync(filePath)).toBe(false)
  })

  it('edits, marks used, finds and removes entries', () => {
    const store = newStore()
    const a = store.add({ origin: 'https://login.a.test', username: 'u1', password: 'p1' })
    const b = store.add({ origin: 'https://www.a.test', username: 'u2', password: 'p2' })
    const aId = a.ok ? a.value.entry.id : ''
    const bId = b.ok ? b.value.entry.id : ''
    clock = 5000
    expect(store.markUsed(aId).ok).toBe(true)
    expect(store.updatePassword(bId, 'p2b').ok).toBe(true)

    const reopened = newStore()
    const found = reopened.findForOrigin('https://login.a.test')
    expect(found.ok && found.value.exact.map((e) => e.id)).toEqual([aId])
    expect(found.ok && found.value.sameSite.map((e) => e.id)).toEqual([bId])
    expect(reopened.getPassword(bId)).toEqual({ ok: true, value: 'p2b' })
    expect(reopened.list()).toMatchObject({
      ok: true,
      value: [
        { id: aId, lastUsedAt: 5000 },
        { id: bId, updatedAt: 5000 }
      ]
    })

    expect(reopened.updateUsername(aId, 'renamed').ok).toBe(true)
    expect(newStore().list()).toMatchObject({ value: [{ username: 'renamed' }, {}] })

    expect(reopened.remove(aId)).toEqual({ ok: true, value: true })
    expect(newStore().getPassword(aId)).toEqual({ ok: false, reason: 'not-found' })
    expect(newStore().remove(aId)).toEqual({ ok: false, reason: 'not-found' })
  })

  it('refuses a username rename that would collide on the same origin', () => {
    const store = newStore()
    store.add({ origin: 'https://a.test', username: 'one', password: 'p' })
    const two = store.add({ origin: 'https://a.test', username: 'two', password: 'p' })
    expect(store.updateUsername(two.ok ? two.value.entry.id : '', 'one')).toEqual({
      ok: false,
      reason: 'duplicate'
    })
  })

  it('fails closed without writing when the secret store reports a protection gap', () => {
    installFakeSecretStore({ gap: 'Linux is storing secrets with basic_text.' })
    const store = newStore()
    expect(store.availability()).toEqual({
      available: false,
      reason: 'Linux is storing secrets with basic_text.'
    })
    expect(store.add({ origin: 'https://a.test', username: 'u', password: 'p' })).toEqual({
      ok: false,
      reason: 'unavailable',
      message: 'Linux is storing secrets with basic_text.'
    })
    expect(store.addNever('https://a.test').ok).toBe(false)
    expect(store.importRows([{ origin: 'https://a.test', username: 'u', password: 'p' }]).ok).toBe(
      false
    )
    expect(existsSync(filePath)).toBe(false)
  })

  it('fails closed when encryption is unavailable', () => {
    installFakeSecretStore({ available: false })
    expect(newStore().availability().available).toBe(false)
    _resetSecretStoreForTests()
    expect(newStore().availability().available).toBe(false)
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

  it('summarises an import: imported, duplicates, conflicts and invalid rows', () => {
    const store = newStore()
    store.add({ origin: 'https://a.test', username: 'u', password: 'saved' })
    clock = 9000
    const result = store.importRows([
      { origin: 'https://a.test/login', username: 'u', password: 'saved' },
      { origin: 'https://a.test', username: 'u', password: 'different' },
      { origin: 'https://b.test', username: 'v', password: 'new', createdAt: 500 },
      { origin: 'https://b.test/again', username: 'v', password: 'new' },
      { origin: 'https://b.test', username: 'v', password: 'changed' },
      { origin: 'android://com.example', username: 'x', password: 'p' },
      { origin: 'https://c.test', username: 'x', password: '' },
      { origin: 'https://c.test', username: '', password: 'username-less' }
    ])
    expect(result).toEqual({
      ok: true,
      value: { imported: 2, duplicates: 2, conflicts: 2, invalid: 2, undecryptable: 0 }
    })
    const reopened = newStore()
    const entries = reopened.list()
    expect(entries.ok && entries.value.map((e) => [e.origin, e.username, e.createdAt])).toEqual([
      ['https://a.test', 'u', 1000],
      ['https://b.test', 'v', 500],
      ['https://c.test', '', 9000]
    ])
    const aId = entries.ok ? entries.value[0].id : ''
    expect(reopened.getPassword(aId)).toEqual({ ok: true, value: 'saved' })
  })

  it('keeps notes sealed apart from the index and drops them with their entry', () => {
    const store = newStore()
    const added = store.add({ origin: 'https://a.test', username: 'u', password: 'p' })
    const id = added.ok ? added.value.entry.id : ''
    expect(store.getNote(id)).toEqual({ ok: true, value: '' })
    store.updateNote(id, 'recovery codes in the safe')
    expect(readFileSync(filePath, 'utf8')).not.toContain('recovery codes')
    expect(newStore().getNote(id)).toEqual({ ok: true, value: 'recovery codes in the safe' })
    store.updateNote(id, '')
    expect(newStore().getNote(id)).toEqual({ ok: true, value: '' })
    store.updateNote(id, 'again')
    store.remove(id)
    expect(newStore().getNote(id)).toEqual({ ok: true, value: '' })
  })

  it('imports notes with their rows', () => {
    const store = newStore()
    store.importRows([{ origin: 'https://n.test', username: 'u', password: 'p', note: 'hi' }])
    const entries = store.list()
    const id = entries.ok ? entries.value[0].id : ''
    expect(store.getNote(id)).toEqual({ ok: true, value: 'hi' })
  })

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

  it('deletes the vault file', () => {
    const store = newStore()
    store.add({ origin: 'https://a.test', username: 'u', password: 'p' })
    expect(store.deleteFile()).toEqual({ ok: true, value: true })
    expect(existsSync(filePath)).toBe(false)
    expect(store.list()).toEqual({ ok: true, value: [] })
  })
})
