import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import type { AntigravityCredentialIdentity } from './native-credential-codec'
import { credential, harness, refreshedWithoutIdToken } from './native-account-test-fixtures'
import { createAntigravityWindowsCredentialBackend } from './native-windows-credentials'
import { parseAntigravityWindowsSnapshot } from './native-windows-token-decode'
import { createFakeWindowsSecurity } from '../../shared/windows-security-addon.test-fixture'
import {
  resetWindowsSecurityLoadForTests,
  setWindowsSecurityForTests
} from '../../shared/windows-security-addon'

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
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  resetWindowsSecurityLoadForTests()
  rmSync(dir, { recursive: true, force: true })
  _resetSecretStoreForTests()
})

describe('protected Antigravity account snapshots', () => {
  it.skipIf(process.platform === 'win32').each([
    [
      '{"auth_method":"consumer","token":{"ACCESS_TOKEN":"fixture-access","refresh_token":"typed-grant"}}',
      'consumer'
    ],
    [
      '{"auth_method":"consumer","token":{"access_token":"fixture-access","access_token":null,"refresh_token":"typed-grant"}}',
      'consumer'
    ],
    [
      '{"auth_method":"consumer","access_token":"fixture-access","refresh_token":"typed-grant"}',
      ''
    ],
    [
      '{"auth_method":"old","AUTH_METHOD":"consumer","token":{"access_token":"fixture-access","refresh_token":"typed-grant"}}',
      'consumer'
    ]
  ])(
    'keeps typed Windows snapshots usable through durable actions and refresh: %s',
    async (raw, authMethod) => {
      // Real filesystem publication here complements the separate native Windows ACL contracts.
      vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
      for (const key of [
        'SSH_TTY',
        'SSH_CLIENT',
        'SSH_CONNECTION',
        'WSL_DISTRO_NAME',
        'WSL_INTEROP'
      ]) {
        vi.stubEnv(key, '')
      }
      const fake = createFakeWindowsSecurity()
      setWindowsSecurityForTests(fake)
      const backend = createAntigravityWindowsCredentialBackend(dir, () => false)
      const path = join(dir, 'typed-vault')
      const store = () => createEncryptedAntigravityAccountStore(path, backend.parse)
      const lookup = vi.fn<(accessToken: string) => Promise<AntigravityCredentialIdentity>>(
        async () => ({
          issuer: 'https://accounts.google.com',
          subject: 'typed',
          email: null
        })
      )
      const reopen = () => new AntigravityAccountService(store(), backend, Date.now, lookup)
      const native = (contents: string) =>
        fake.writeGenericCredential('gemini:antigravity', 'antigravity', Buffer.from(contents))
      native(credential('prior'))
      let service = reopen()
      const prior = (await service.addCurrentAccount()).activeAccountId!
      native(raw)
      const typed = (await service.addCurrentAccount()).activeAccountId!
      expect(typed).not.toBe(prior)
      expect(
        store()
          .read()
          .accounts.map((account) => account.credentials)
      ).toEqual([credential('prior'), raw])
      service = reopen()
      expect(await service.listAccounts()).toMatchObject({
        activeAccountId: typed,
        currentAccount: { subject: 'typed', authMethod }
      })
      await service.selectAccount(prior)
      expect(new TextDecoder().decode(fake.readGenericCredential('gemini:antigravity')!)).toBe(
        credential('prior')
      )
      const before = readFileSync(path)
      vi.spyOn(getSecretStore(), 'encryptString').mockImplementationOnce(() => {
        throw new Error('synthetic final publication failure')
      })
      await expect(service.selectAccount(typed)).rejects.toThrow('could not be saved')
      expect(new TextDecoder().decode(fake.readGenericCredential('gemini:antigravity')!)).toBe(raw)
      expect(readFileSync(path)).toEqual(before)
      service = reopen()
      expect(await service.listAccounts()).toMatchObject({
        activeAccountId: typed,
        selectedAccountId: prior
      })
      expect((await service.selectAccount(typed)).selectedAccountId).toBe(typed)
      const refreshed = authMethod
        ? '{"AUTH_METHOD":"consumer","TOKEN":{"ACCESS_TOKEN":"rotated","REFRESH_TOKEN":"typed-grant"}}'
        : '{"ACCESS_TOKEN":"rotated","REFRESH_TOKEN":"typed-grant"}'
      native(refreshed)
      expect((await service.listAccounts()).activeAccountId).toBe(typed)
      expect(
        store()
          .read()
          .accounts.map((account) => account.credentials)
      ).toEqual([credential('prior'), refreshed])
      service = reopen()
      expect(await service.listAccounts()).toMatchObject({
        activeAccountId: typed,
        selectedAccountId: typed,
        accounts: [
          { id: prior, subject: 'prior' },
          { id: typed, subject: 'typed' }
        ]
      })
      expect(lookup).toHaveBeenCalledTimes(1)
      await service.selectAccount(prior)
      await service.removeAccount(typed)
      expect(await reopen().listAccounts()).toMatchObject({
        activeAccountId: prior,
        selectedAccountId: prior,
        accounts: [{ id: prior, subject: 'prior' }]
      })
      expect(
        store()
          .read()
          .accounts.map((account) => account.credentials)
      ).toEqual([credential('prior')])
    }
  )

  it('reopens a legacy agy snapshot without a schema change or invented auth method', async () => {
    const contents = '{"access_token":"fixture-only","refresh_token":"fixture-refresh"}'
    const h = harness(contents)
    h.lookupIdentity.mockResolvedValue({
      issuer: 'https://accounts.google.com',
      subject: 'legacy',
      email: null
    })
    await h.service.addCurrentAccount()
    const path = join(dir, 'legacy-vault')
    const store = createEncryptedAntigravityAccountStore(path)
    store.write(h.getVault())
    expect(createEncryptedAntigravityAccountStore(path).read().accounts[0]).toMatchObject({
      credentials: contents,
      authMethod: ''
    })
  })
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
    expect(readFileSync(path).equals(before)).toBe(true)
    expect(store.read().accounts).toHaveLength(52)
    h.setNative(paddedCredential('large-51', 65000))
    await expect(service.listAccounts()).rejects.toThrow('could not be saved')
    expect(readFileSync(path).equals(before)).toBe(true)
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
    const typedStore = createEncryptedAntigravityAccountStore(path, parseAntigravityWindowsSnapshot)
    expect(typedStore.read()).toEqual(vault)
    for (const mismatch of [{ authMethod: 'inconsistent' }, { subject: 'inconsistent' }]) {
      typedStore.write({
        ...vault,
        accounts: vault.accounts.map((account) => ({ ...account, ...mismatch }))
      })
      const before = readFileSync(path)
      expect(() => typedStore.read()).toThrow('preserved')
      expect(readFileSync(path)).toEqual(before)
    }
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
      expect(readFileSync(path).equals(before)).toBe(true)
    }
  )

  it('keeps the selected account launchable after agy refreshes its token without an id_token', async () => {
    const h = harness()
    const store = createEncryptedAntigravityAccountStore(join(dir, 'vault'))
    const service = new AntigravityAccountService(store, h.backend)
    const id = (await service.addCurrentAccount()).activeAccountId!
    await service.selectAccount(id)
    h.setNative(refreshedWithoutIdToken(2))
    await service.prepareForLaunch()
    const restarted = new AntigravityAccountService(store, h.backend)
    h.setNative(refreshedWithoutIdToken(3))
    expect(await restarted.listAccounts()).toMatchObject({
      activeAccountId: id,
      selectedAccountId: id,
      currentAccount: { subject: 'a', identityKnown: true }
    })
    await restarted.prepareForLaunch()
    expect(store.read().accounts[0].credentials).toBe(refreshedWithoutIdToken(3))
    h.setNative(refreshedWithoutIdToken(4, 'refresh-other-grant'))
    await expect(restarted.prepareForLaunch()).rejects.toThrow('native Antigravity account changed')
    expect(h.backend.write).not.toHaveBeenCalled()
  })

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
