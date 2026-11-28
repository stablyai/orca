import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  _resetSecretStoreForTests,
  getSecretStore,
  setSecretStore
} from '../../shared/secure-storage/secret-store'
import { createEncryptedAntigravityAccountStore } from './native-account-store'
import { AntigravityAccountService } from './native-account-service'
import type { AntigravityCredentialIdentity } from './native-credential-codec'
import { credential, harness, refreshedWithoutIdToken } from './native-account-test-fixtures'
import { createAntigravityWindowsCredentialBackend } from './native-windows-credentials'
import { AntigravityKeychainAccessError, keychainAccessIsBrief } from './native-macos-credentials'
import { parseAntigravityWindowsSnapshot } from './native-windows-token-decode'
import { createFakeWindowsSecurity } from '../../shared/secure-storage/windows-security-addon.test-fixture'
import {
  resetWindowsSecurityLoadForTests,
  setWindowsSecurityForTests
} from '../../shared/secure-storage/windows-security-addon'

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
      '{"auth_method":"consumer","access_token":"fixture-access","refresh_token":"typed-grant"}',
      ''
    ],
    [
      '{"auth_method":"old","AUTH_METHOD":"consumer","token":{"ACCESS_TOKEN":"fixture-access","access_token":null,"refresh_token":"typed-grant"}}',
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
      expect((await store().read()).accounts.map((account) => account.credentials)).toEqual([
        credential('prior'),
        raw
      ])
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
      expect((await store().read()).accounts.map((account) => account.credentials)).toEqual([
        credential('prior'),
        refreshed
      ])
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
      expect((await store().read()).accounts.map((account) => account.credentials)).toEqual([
        credential('prior')
      ])
    }
  )

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
    await store.write(vault)
    const before = readFileSync(path)
    const service = new AntigravityAccountService(store, h.backend)
    h.setNative(paddedCredential('new-account', 60000))
    await expect(service.addCurrentAccount()).rejects.toThrow('could not be saved')
    expect(readFileSync(path).equals(before)).toBe(true)
    expect((await store.read()).accounts).toHaveLength(52)
    h.setNative(paddedCredential('large-51', 65000))
    await expect(service.listAccounts()).rejects.toThrow('could not be saved')
    expect(readFileSync(path).equals(before)).toBe(true)
    expect((await store.read()).accounts).toHaveLength(52)
  })

  it('persists a selected account with exact provider fields and private permissions across restart', async () => {
    const h = harness()
    const state = await h.service.addCurrentAccount()
    const vault = h.getVault()
    vault.selectedAccountId = state.activeAccountId
    const path = join(dir, 'accounts', 'vault')
    await createEncryptedAntigravityAccountStore(path).write(vault)
    expect(readFileSync(path, 'utf8')).not.toContain('synthetic-1')
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o077).toBe(0)
    }
    expect(await createEncryptedAntigravityAccountStore(path).read()).toEqual(vault)
    expect(
      (await createEncryptedAntigravityAccountStore(path).read()).accounts[0].credentials
    ).toBe(credential('a'))
    const typedStore = createEncryptedAntigravityAccountStore(path, parseAntigravityWindowsSnapshot)
    expect(await typedStore.read()).toEqual(vault)
    for (const mismatch of [{ authMethod: 'inconsistent' }, { subject: 'inconsistent' }]) {
      await typedStore.write({
        ...vault,
        accounts: vault.accounts.map((account) => ({ ...account, ...mismatch }))
      })
      const before = readFileSync(path)
      await expect(typedStore.read()).rejects.toThrow('preserved')
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
      await store.write(h.getVault())
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
      await expect(store.write({ accounts: [], selectedAccountId: null })).rejects.toThrow(
        'Protected secret storage'
      )
      await expect(store.read()).rejects.toThrow('Protected secret storage')
      expect(readFileSync(path).equals(before)).toBe(true)
    }
  )

  it('keeps the selected account launchable across refreshes and a verified grant rotation', async () => {
    const h = harness()
    const store = createEncryptedAntigravityAccountStore(join(dir, 'vault'))
    const service = new AntigravityAccountService(store, h.backend)
    const id = (await service.addCurrentAccount()).activeAccountId!
    await service.selectAccount(id)
    h.setNative(refreshedWithoutIdToken(2))
    await service.prepareForLaunch()
    const restarted = new AntigravityAccountService(store, h.backend, Date.now, h.lookupIdentity)
    h.setNative(refreshedWithoutIdToken(3))
    expect(await restarted.listAccounts()).toMatchObject({
      activeAccountId: id,
      selectedAccountId: id,
      currentAccount: { subject: 'a', identityKnown: true }
    })
    await restarted.prepareForLaunch()
    expect((await store.read()).accounts[0].credentials).toBe(refreshedWithoutIdToken(3))
    h.setNative(refreshedWithoutIdToken(4, 'refresh-other-grant'))
    await expect(restarted.prepareForLaunch()).rejects.toThrow('native Antigravity account changed')
    h.lookupIdentity.mockClear()

    h.lookupIdentity.mockResolvedValue({
      issuer: 'https://accounts.google.com',
      subject: 'a',
      email: 'a@example.invalid'
    })
    h.setNative(refreshedWithoutIdToken(5, 'refresh-rotated'))
    await restarted.prepareForLaunch()
    expect((await store.read()).accounts[0].credentials).toBe(
      refreshedWithoutIdToken(5, 'refresh-rotated')
    )
    await restarted.prepareForLaunch()
    expect(h.lookupIdentity).toHaveBeenCalledTimes(1)
    h.lookupIdentity.mockResolvedValue({
      issuer: 'https://accounts.google.com',
      subject: 'someone-else',
      email: null
    })
    h.setNative(refreshedWithoutIdToken(6, 'refresh-other-grant'))
    await expect(restarted.prepareForLaunch()).rejects.toThrow('native Antigravity account changed')
    expect(h.backend.write).not.toHaveBeenCalled()
  })

  it('restores the selected account at launch after another running agy refreshes a saved login over it', async () => {
    const h = harness()
    const selected = (await h.service.addCurrentAccount()).activeAccountId!
    h.setNative(credential('b', 2))
    await h.service.addCurrentAccount()
    await h.service.selectAccount(selected)
    // An agy still running on b refreshes its token and writes b's login back.
    h.setNative(refreshedWithoutIdToken(3, 'refresh-2'))
    // Orca's own sign-in may be about to put an unsaved login there: never restore over it.
    h.setSignInHeld(true)
    await expect(h.service.prepareForLaunch()).rejects.toThrow('sign-in is in progress')
    expect(h.getNative()).toBe(refreshedWithoutIdToken(3, 'refresh-2'))
    h.setSignInHeld(false)
    await h.service.prepareForLaunch()
    expect(h.getNative()).toBe(credential('a'))
    expect(h.getVault()).toMatchObject({
      selectedAccountId: selected,
      accounts: [
        { credentials: credential('a') },
        { credentials: refreshedWithoutIdToken(3, 'refresh-2') }
      ]
    })
  })

  it('names a keychain login only from a read made while its item is unchanged, and never reads it to list', async () => {
    const h = harness(credential('a'), { keychain: true })
    const store = createEncryptedAntigravityAccountStore(join(dir, 'vault'))
    const launchRestore = { signInHoldsLogin: () => false }
    const service = new AntigravityAccountService(
      store,
      h.backend,
      Date.now,
      h.lookupIdentity,
      launchRestore
    )
    const unread = {
      activeAccountId: null,
      currentAccount: { email: null, subject: null, identityKnown: false, unread: true }
    }
    expect(await service.listAccounts()).toMatchObject(unread)
    expect(h.backend.read).not.toHaveBeenCalled()

    const id = (await service.addCurrentAccount()).activeAccountId!
    await service.selectAccount(id)
    vi.mocked(h.backend.read).mockClear()
    const named = {
      activeAccountId: id,
      currentAccount: { email: 'a@example.invalid', subject: 'a', identityKnown: true }
    }
    expect(await service.listAccounts()).toMatchObject(named)
    // The name outlives a restart while agy's keychain item is unchanged.
    const restarted = new AntigravityAccountService(
      store,
      h.backend,
      Date.now,
      h.lookupIdentity,
      launchRestore
    )
    expect(await restarted.listAccounts()).toMatchObject(named)
    await restarted.prepareForLaunch({ mayPrompt: false })
    expect(h.backend.read).not.toHaveBeenCalled()

    // agy rewrote its login: which account it holds is unknown until Orca reads it again.
    h.setNative(refreshedWithoutIdToken(2))
    expect(await restarted.listAccounts()).toMatchObject({ ...unread, selectedAccountId: id })
    expect(h.backend.read).not.toHaveBeenCalled()
    // A launch reads it once, and the next listing names it from that read.
    await restarted.prepareForLaunch()
    expect(h.backend.read).toHaveBeenCalledTimes(1)
    expect(await restarted.listAccounts()).toMatchObject({ activeAccountId: id })
    expect(h.backend.read).toHaveBeenCalledTimes(1)

    // A chat's brief read that fails stops chats asking; a launch's refused read isn't asked again
    // under the same revision.
    h.setNative(refreshedWithoutIdToken(3))
    let brief = false
    vi.mocked(h.backend.read).mockImplementationOnce(async () => {
      brief = keychainAccessIsBrief()
      throw new AntigravityKeychainAccessError('no answer')
    })
    await expect(restarted.prepareForLaunch({ mayPrompt: false })).rejects.toThrow('no answer')
    expect(brief).toBe(true)
    vi.mocked(h.backend.read).mockRejectedValueOnce(new Error('denied'))
    await expect(restarted.prepareForLaunch()).rejects.toThrow('denied')
    await expect(restarted.prepareForLaunch()).rejects.toThrow('denied')
    h.setNative(refreshedWithoutIdToken(4))
    await expect(restarted.prepareForLaunch({ mayPrompt: false })).rejects.toThrow(
      'keychain access'
    )
    expect(h.backend.read).toHaveBeenCalledTimes(3)
  })

  it('lets a later chat restore the selection after a sign-in, not a keychain refusal, held one back', async () => {
    const h = harness(credential('a'), { keychain: true })
    const selected = (await h.service.addCurrentAccount()).activeAccountId!
    h.setNative(credential('b', 2))
    await h.service.addCurrentAccount()
    await h.service.selectAccount(selected)
    h.setNative(refreshedWithoutIdToken(3, 'refresh-2'))
    h.setSignInHeld(true)
    await expect(h.service.prepareForLaunch({ mayPrompt: false })).rejects.toThrow(
      'sign-in is in progress'
    )
    h.setSignInHeld(false)
    await h.service.prepareForLaunch({ mayPrompt: false })
    expect(h.getNative()).toBe(credential('a'))
  })

  it('removes the selected account after agy signs in to another one, unblocking launches', async () => {
    const h = harness()
    const id = (await h.service.addCurrentAccount()).activeAccountId!
    await h.service.selectAccount(id)
    await expect(h.service.removeAccount(id)).rejects.toThrow('Switch agy to another account')
    h.setNative(credential('b'))
    await expect(h.service.prepareForLaunch()).rejects.toThrow('native Antigravity account changed')
    expect(await h.service.removeAccount(id)).toMatchObject({
      accounts: [],
      activeAccountId: null,
      selectedAccountId: null,
      currentAccount: { subject: 'b' }
    })
    await h.service.prepareForLaunch()
    expect(h.getNative()).toBe(credential('b'))
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a broadly readable persisted snapshot',
    async () => {
      const h = harness()
      await h.service.addCurrentAccount()
      const path = join(dir, 'vault')
      const store = createEncryptedAntigravityAccountStore(path)
      await store.write(h.getVault())
      chmodSync(path, 0o644)
      await expect(store.read()).rejects.toThrow('preserved')
    }
  )
})
