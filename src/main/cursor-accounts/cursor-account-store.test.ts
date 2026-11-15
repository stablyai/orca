import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secret-store'
import { createEncryptedCursorAccountStore } from './cursor-account-store'
import { cursorSnapshot } from './cursor-account-test-fixtures'
import { serializeCursorSnapshot } from './cursor-native-credential'

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-cursor-vault-'))
  path = join(dir, 'cursor-accounts', 'vault')
  setSecretStore({
    isEncryptionAvailable: () => true,
    describeProtectionGap: () => null,
    encryptString: (value) => Buffer.from(`sealed:${Buffer.from(value).toString('base64')}`),
    decryptString: (value) => {
      if (!value.toString().startsWith('sealed:')) {
        throw new Error('synthetic decrypt failure')
      }
      return Buffer.from(value.toString().slice(7), 'base64').toString()
    }
  })
})
afterEach(() => {
  _resetSecretStoreForTests()
  rmSync(dir, { recursive: true, force: true })
})

function account(subject: string, id = `id-${subject}`) {
  return {
    id,
    email: `${subject}@example.invalid`,
    displayName: null,
    subject,
    createdAt: 1,
    updatedAt: 2,
    credentials: serializeCursorSnapshot(cursorSnapshot(subject))
  }
}

describe('Cursor account vault', () => {
  it('starts empty and round-trips accounts without writing tokens in clear text', () => {
    const store = createEncryptedCursorAccountStore(path)
    expect(store.read()).toEqual({ accounts: [], selectedAccountId: null })

    const vault = { accounts: [account('user_a')], selectedAccountId: 'id-user_a' }
    store.write(vault)

    expect(store.read()).toEqual(vault)
    expect(readFileSync(path, 'utf8')).not.toContain('refresh-user_a-1')
    expect(statSync(path).mode & 0o077).toBe(0)
  })

  it('refuses to read or write without protected secret storage', () => {
    createEncryptedCursorAccountStore(path).write({ accounts: [], selectedAccountId: null })
    setSecretStore({
      isEncryptionAvailable: () => false,
      describeProtectionGap: () => 'no keychain',
      encryptString: () => Buffer.alloc(0),
      decryptString: () => ''
    })
    const store = createEncryptedCursorAccountStore(path)
    expect(() => store.read()).toThrow('Protected secret storage is unavailable')
    expect(() => store.write({ accounts: [], selectedAccountId: null })).toThrow(
      'Protected secret storage is unavailable'
    )
  })

  it('rejects a vault readable by other users', () => {
    const store = createEncryptedCursorAccountStore(path)
    store.write({ accounts: [account('user_a')], selectedAccountId: null })
    chmodSync(path, 0o644)
    expect(() => store.read()).toThrow('existing vault was preserved')
  })

  it('rejects a vault whose saved identity does not match its credentials', () => {
    const store = createEncryptedCursorAccountStore(path)
    store.write({
      accounts: [{ ...account('user_a'), subject: 'user_other' }],
      selectedAccountId: null
    })
    expect(() => store.read()).toThrow('existing vault was preserved')
  })

  it('rejects a selection that names no saved account', () => {
    const store = createEncryptedCursorAccountStore(path)
    store.write({ accounts: [account('user_a')], selectedAccountId: 'missing' })
    expect(() => store.read()).toThrow('existing vault was preserved')
  })

  it('rejects a corrupt vault file', () => {
    const store = createEncryptedCursorAccountStore(path)
    store.write({ accounts: [], selectedAccountId: null })
    writeFileSync(path, 'not sealed', { mode: 0o600 })
    expect(() => store.read()).toThrow('existing vault was preserved')
  })
})
