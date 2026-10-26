import { describe, expect, it, vi } from 'vitest'
import { AntigravityAccountService } from './native-account-service'
import type {
  AntigravityIdentityResolver,
  ResolvedGoogleIdentity
} from './google-userinfo-identity'
import { credential, harness } from './native-account-test-fixtures'

// What agy 1.4.x keeps in the keychain: no id_token anywhere, just an email label.
function agyCredential(accessToken: string, refreshToken = 'synthetic-refresh'): string {
  return JSON.stringify({
    auth_method: 'consumer',
    id_token_email: 'label@example.invalid',
    token: { access_token: accessToken, refresh_token: refreshToken, expiry: 1 }
  })
}

function withLookup(
  initial: string | null,
  answer: ResolvedGoogleIdentity | Error = { subject: 'google-subject', email: 'a@example.invalid' }
) {
  const h = harness(initial)
  const resolver = vi.fn<AntigravityIdentityResolver>(async () => {
    if (answer instanceof Error) {
      throw answer
    }
    return answer
  })
  const service = new AntigravityAccountService(h.store, h.backend, Date.now, resolver)
  return { ...h, service, resolver }
}

describe('Save current account asks Google who an id_token-less credential belongs to', () => {
  it('offers to resolve the identity, but does not ask Google just to list', async () => {
    const h = withLookup(agyCredential('synthetic-access-1'))
    const state = await h.service.listAccounts()

    expect(state.currentAccount).toMatchObject({ identityKnown: false, identityResolvable: true })
    expect(h.resolver).not.toHaveBeenCalled()
  })

  it('saves the account under the subject Google confirms, with the credential untouched', async () => {
    const h = withLookup(agyCredential('synthetic-access-1'))
    const state = await h.service.addCurrentAccount()

    expect(h.resolver).toHaveBeenCalledTimes(1)
    expect(h.resolver).toHaveBeenCalledWith('synthetic-access-1')
    expect(state.accounts).toHaveLength(1)
    expect(state.accounts[0]).toMatchObject({
      subject: 'google-subject',
      email: 'a@example.invalid'
    })
    expect(h.getVault().accounts[0].credentials).toBe(agyCredential('synthetic-access-1'))
    expect(state.activeAccountId).toBe(state.accounts[0].id)
    expect(state.currentAccount).toMatchObject({
      subject: 'google-subject',
      identityKnown: true,
      identityResolvable: false
    })
  })

  it('does not hand the tokens back in the state it returns', async () => {
    const h = withLookup(agyCredential('synthetic-access-1', 'synthetic-refresh-1'))
    const text = JSON.stringify(await h.service.addCurrentAccount())
    expect(text).not.toContain('synthetic-access-1')
    expect(text).not.toContain('synthetic-refresh-1')
  })

  it('stays the same account through later refreshes without asking Google again', async () => {
    const h = withLookup(agyCredential('synthetic-access-1'))
    const id = (await h.service.addCurrentAccount()).activeAccountId!
    h.setNative(agyCredential('synthetic-access-2'))

    const refreshed = await h.service.listAccounts()
    expect(refreshed.activeAccountId).toBe(id)
    expect((await h.service.addCurrentAccount()).accounts).toHaveLength(1)
    expect(h.getVault().accounts[0].credentials).toContain('synthetic-access-2')
    expect(h.resolver).toHaveBeenCalledTimes(1)
  })

  it('selects, switches and launches without ever asking Google', async () => {
    const h = withLookup(agyCredential('synthetic-access-1'))
    const first = (await h.service.addCurrentAccount()).activeAccountId!
    h.setNative(credential('b'))
    const second = (await h.service.addCurrentAccount()).activeAccountId!
    await h.service.selectAccount(first)
    expect(h.getNative()).toBe(agyCredential('synthetic-access-1'))
    await h.service.selectAccount(second)
    await h.service.prepareForLaunch()
    await h.service.listAccounts()

    expect(h.resolver).toHaveBeenCalledTimes(1)
  })

  it('does not ask Google for a credential that already names its account', async () => {
    const h = withLookup(credential('a'))
    await h.service.addCurrentAccount()
    expect(h.resolver).not.toHaveBeenCalled()
  })

  it('saves nothing when Google cannot confirm the account', async () => {
    const h = withLookup(agyCredential('synthetic-access-1'), new Error('Google rejected it'))
    await expect(h.service.addCurrentAccount()).rejects.toThrow('Google rejected it')

    expect(h.getVault().accounts).toHaveLength(0)
    expect(h.store.write).not.toHaveBeenCalled()
    expect((await h.service.listAccounts()).currentAccount?.identityResolvable).toBe(true)
  })

  it('recovers the mutation queue after a failed lookup', async () => {
    const h = withLookup(agyCredential('synthetic-access-1'), new Error('offline'))
    await expect(h.service.addCurrentAccount()).rejects.toThrow('offline')
    h.resolver.mockResolvedValueOnce({ subject: 'google-subject', email: null })

    expect((await h.service.addCurrentAccount()).accounts).toHaveLength(1)
  })

  it('files a new sign-in of an already saved Google account under that account', async () => {
    const h = withLookup(agyCredential('synthetic-access-1', 'refresh-old'))
    const id = (await h.service.addCurrentAccount()).activeAccountId!
    h.setNative(agyCredential('synthetic-access-9', 'refresh-new'))

    const state = await h.service.addCurrentAccount()
    expect(state.accounts).toHaveLength(1)
    expect(state.activeAccountId).toBe(id)
    expect(h.getVault().accounts[0].credentials).toBe(
      agyCredential('synthetic-access-9', 'refresh-new')
    )
  })

  it('keeps two different Google accounts apart', async () => {
    const h = withLookup(agyCredential('synthetic-access-1', 'refresh-a'))
    await h.service.addCurrentAccount()
    h.setNative(agyCredential('synthetic-access-2', 'refresh-b'))
    h.resolver.mockResolvedValueOnce({ subject: 'another-subject', email: 'b@example.invalid' })

    const state = await h.service.addCurrentAccount()
    expect(state.accounts.map((account) => account.subject).sort()).toEqual([
      'another-subject',
      'google-subject'
    ])
    expect(state.activeAccountId).toBe(
      state.accounts.find((a) => a.subject === 'another-subject')?.id
    )
  })

  it('keeps a previously saved email when Google returns none', async () => {
    const h = withLookup(agyCredential('synthetic-access-1', 'refresh-old'))
    await h.service.addCurrentAccount()
    h.setNative(agyCredential('synthetic-access-2', 'refresh-new'))
    h.resolver.mockResolvedValueOnce({ subject: 'google-subject', email: null })

    await h.service.addCurrentAccount()
    expect(h.getVault().accounts[0].email).toBe('a@example.invalid')
  })

  it('saves an account with no email when Google confirms none', async () => {
    const h = withLookup(agyCredential('synthetic-access-1'), {
      subject: 'google-subject',
      email: null
    })
    const state = await h.service.addCurrentAccount()
    expect(state.accounts[0].email).toBeNull()
  })

  it('does not lose an account another writer saved while Google was being asked', async () => {
    const h = withLookup(agyCredential('synthetic-access-1'))
    h.resolver.mockImplementationOnce(async () => {
      const vault = h.getVault()
      vault.accounts.push({
        id: 'concurrent',
        email: null,
        subject: 'concurrent-subject',
        authMethod: 'consumer',
        credentials: credential('concurrent-subject'),
        createdAt: 1,
        updatedAt: 1
      })
      h.store.write(vault)
      return { subject: 'google-subject', email: null }
    })

    const state = await h.service.addCurrentAccount()
    expect(state.accounts.map((account) => account.subject).sort()).toEqual([
      'concurrent-subject',
      'google-subject'
    ])
  })

  it('saves nothing when agy rewrites the credential while Google is being asked', async () => {
    const h = withLookup(agyCredential('synthetic-access-1'))
    h.resolver.mockImplementationOnce(async () => {
      h.setNative(agyCredential('synthetic-access-2', 'refresh-other'))
      return { subject: 'google-subject', email: null }
    })

    await expect(h.service.addCurrentAccount()).rejects.toThrow('changed while saving')
    expect(h.getVault().accounts).toHaveLength(0)
  })

  it('does not offer the lookup for a credential that continues a saved account', async () => {
    const h = withLookup(agyCredential('synthetic-access-1'))
    await h.service.addCurrentAccount()
    h.setNative(agyCredential('synthetic-access-2'))
    const state = await h.service.listAccounts()

    expect(state.currentAccount).toMatchObject({ identityKnown: true, identityResolvable: false })
  })
})

describe('without a host that can ask Google', () => {
  it('refuses an id_token-less credential exactly as before and offers no lookup', async () => {
    const h = harness(agyCredential('synthetic-access-1'))
    const state = await h.service.listAccounts()

    expect(state.currentAccount).toEqual({
      email: null,
      subject: null,
      authMethod: 'consumer',
      identityKnown: false
    })
    await expect(h.service.addCurrentAccount()).rejects.toThrow('no stable Google identity')
    expect(h.getVault().accounts).toHaveLength(0)
  })
})
