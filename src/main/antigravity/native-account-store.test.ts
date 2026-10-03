import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _resetSecretStoreForTests,
  getSecretStore,
  setSecretStore
} from '../../shared/secret-store'
import { createEncryptedAntigravityAccountStore } from './native-account-store'
import { AntigravityAccountService } from './native-account-service'
import { credential, harness } from './native-account-test-fixtures'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-agy-vault-test-'))
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
  rmSync(dir, { recursive: true, force: true })
  _resetSecretStoreForTests()
})

describe('protected Antigravity account snapshots', () => {
  it('preserves readable bytes when adding an account or refreshing a token exceeds the encrypted cap', async () => {
    function paddedCredential(subject: string, bytes: number) {
      const prefix = `${credential(subject).slice(0, -1)},"padding":"`
      return `${prefix}${'x'.repeat(bytes - Buffer.byteLength(`${prefix}"}`))}"}`
    }
    const h = harness()
    await h.service.addCurrentAccount()
    const template = h.getVault().accounts[0]
    const vault = {
      selectedAccountId: null,
      accounts: Array.from({ length: 52 }, (_, i) => ({
        ...template,
        id: `large-${i}`,
        subject: `large-${i}`,
        credentials: paddedCredential(`large-${i}`, 60000)
      }))
    }
    const cap = 4 * 1024 * 1024
    const encryptedSize = () => getSecretStore().encryptString(JSON.stringify(vault)).length
    for (const account of vault.accounts.slice(0, -1)) {
      const growth = Math.min(5000, Math.floor(((cap - encryptedSize() - 1024) * 3) / 4))
      if (growth <= 0) {
        break
      }
      account.credentials = paddedCredential(account.subject, 60000 + growth)
    }
    expect(encryptedSize()).toBeLessThanOrEqual(cap)
    expect(cap - encryptedSize()).toBeLessThan(2000)
    const path = join(dir, 'vault')
    const store = createEncryptedAntigravityAccountStore(path)
    store.write(vault)
    const before = readFileSync(path)
    const service = new AntigravityAccountService(store, h.backend)
    h.setNative(paddedCredential('new-account', 60000))
    await expect(service.addCurrentAccount()).rejects.toThrow('could not be saved')
    expect(readFileSync(path)).toEqual(before)
    expect(store.read().accounts).toHaveLength(52)
    h.setNative(paddedCredential('large-51', 65000))
    await expect(service.listAccounts()).rejects.toThrow('could not be saved')
    expect(readFileSync(path)).toEqual(before)
    expect(store.read().accounts).toHaveLength(52)
  })

  it('persists a selected account with exact provider fields and private permissions across restart', async () => {
    const h = harness()
    const state = await h.service.addCurrentAccount()
    const vault = h.getVault()
    vault.selectedAccountId = state.activeAccountId
    const path = join(dir, 'accounts', 'vault')
    createEncryptedAntigravityAccountStore(path).write(vault)
    expect(readFileSync(path, 'utf8')).not.toContain('synthetic-1')
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o077).toBe(0)
    }
    expect(createEncryptedAntigravityAccountStore(path).read()).toEqual(vault)
    expect(createEncryptedAntigravityAccountStore(path).read().accounts[0].credentials).toBe(
      credential('a')
    )
  })

  it.each([false, true])(
    'refuses unavailable or weak encryption without changing saved bytes (available=%s)',
    async (available) => {
      const h = harness()
      await h.service.addCurrentAccount()
      const path = join(dir, 'vault')
      const store = createEncryptedAntigravityAccountStore(path)
      store.write(h.getVault())
      const before = readFileSync(path)
      setSecretStore({
        isEncryptionAvailable: () => available,
        describeProtectionGap: () => 'unprotected',
        encryptString: () => {
          throw new Error('must not encrypt')
        },
        decryptString: () => {
          throw new Error('must not decrypt')
        }
      })
      expect(() => store.write({ accounts: [], selectedAccountId: null })).toThrow(
        'Protected secret storage'
      )
      expect(() => store.read()).toThrow('Protected secret storage')
      expect(readFileSync(path)).toEqual(before)
    }
  )

  it('keeps an unreadable vault intact rather than treating it as empty', () => {
    const path = join(dir, 'vault')
    writeFileSync(path, 'broken ciphertext', { mode: 0o600 })
    expect(() => createEncryptedAntigravityAccountStore(path).read()).toThrow('preserved')
    expect(readFileSync(path, 'utf8')).toBe('broken ciphertext')
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a broadly readable persisted snapshot',
    async () => {
      const h = harness()
      await h.service.addCurrentAccount()
      const path = join(dir, 'vault')
      const store = createEncryptedAntigravityAccountStore(path)
      store.write(h.getVault())
      chmodSync(path, 0o644)
      expect(() => store.read()).toThrow('preserved')
    }
  )
})
