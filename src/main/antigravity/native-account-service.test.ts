import { describe, expect, it, vi } from 'vitest'
import { AntigravityAccountService } from './native-account-service'
import { parseAntigravityNativeCredential } from './native-credential-codec'
import { credential, harness } from './native-account-test-fixtures'

describe('Antigravity native account identity and selection', () => {
  it('verifies selection without exposing unrelated native discovery when disabled', async () => {
    const h = harness()
    const id = (await h.service.addCurrentAccount()).activeAccountId!
    await h.service.selectAccount(id)
    h.setNative(credential('another'))
    vi.mocked(h.backend.read).mockClear()

    const state = await h.service.listAccounts(false)

    expect(h.backend.read).toHaveBeenCalledOnce()
    expect(state.accounts).toHaveLength(1)
    expect(state.selectedAccountId).toBe(id)
    expect(state.activeAccountId).toBeNull()
    expect(state.currentAccount).toBeNull()
    expect((await h.service.addCurrentAccount()).accounts).toHaveLength(2)
    expect(h.backend.read).toHaveBeenCalled()
  })

  it('resolves detection policy when a queued list begins', async () => {
    const h = harness()
    const started = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    vi.mocked(h.backend.read).mockImplementationOnce(async () => {
      started.resolve()
      await gate.promise
      return parseAntigravityNativeCredential(credential('a'))
    })
    const add = h.service.addCurrentAccount()
    await started.promise
    let enabled = true
    const listing = h.service.listAccounts(() => enabled)
    enabled = false
    gate.resolve()
    const saved = await add
    const result = await listing
    expect(h.backend.read).toHaveBeenCalledOnce()
    expect(result.accounts).toEqual(saved.accounts)
    expect(result.currentAccount).toBeNull()
    expect(result.activeAccountId).toBeNull()
  })

  it('checks the live vault when an opted-out list is queued behind selection', async () => {
    const h = harness()
    const id = (await h.service.addCurrentAccount()).activeAccountId!
    const started = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    vi.mocked(h.backend.read).mockImplementationOnce(async () => {
      started.resolve()
      await gate.promise
      return parseAntigravityNativeCredential(credential('a'))
    })
    const selecting = h.service.selectAccount(id)
    await started.promise
    const listing = h.service.listAccounts(false)
    gate.resolve()
    await selecting
    expect((await listing).activeAccountId).toBe(id)
  })

  it('discards pending discovery after opt-out without updating managed snapshots', async () => {
    const h = harness()
    const id = (await h.service.addCurrentAccount()).activeAccountId!
    const original = h.getVault()
    const started = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    vi.mocked(h.backend.read).mockImplementationOnce(async () => {
      started.resolve()
      await gate.promise
      return parseAntigravityNativeCredential(credential('a', 2, 'private@example.invalid'))
    })
    let enabled = true
    const listing = h.service.listAccounts(() => enabled)
    await started.promise
    enabled = false
    gate.resolve()
    const result = await listing
    expect(result.currentAccount).toBeNull()
    expect(result.activeAccountId).toBeNull()
    expect(result.selectedAccountId).toBeNull()
    expect(result.accounts[0].id).toBe(id)
    expect(h.getVault()).toEqual(original)
    expect(result.accounts[0].email).toBe('a@example.invalid')
  })

  it('does not probe saved but unselected accounts while opted out', async () => {
    const h = harness()
    await h.service.addCurrentAccount()
    vi.mocked(h.backend.read).mockClear()
    expect((await h.service.listAccounts(false)).currentAccount).toBeNull()
    expect(h.backend.read).not.toHaveBeenCalled()
  })

  it('verifies the selected managed identity and refreshes only its snapshot while opted out', async () => {
    const h = harness()
    const a = (await h.service.addCurrentAccount()).activeAccountId!
    h.setNative(credential('b'))
    await h.service.addCurrentAccount()
    await h.service.selectAccount(a)
    h.setNative(credential('a', 2))
    const result = await h.service.listAccounts(false)
    expect(result.activeAccountId).toBe(a)
    expect(result.currentAccount?.subject).toBe('a')
    expect(h.getVault().accounts[0].credentials).toBe(credential('a', 2))
    const original = h.getVault()
    h.setNative(credential('b', 2))
    expect((await h.service.listAccounts(false)).currentAccount).toBeNull()
    expect(h.getVault()).toEqual(original)
  })

  it('does not substitute a saved identity when native verification is unavailable', async () => {
    const h = harness()
    const id = (await h.service.addCurrentAccount()).activeAccountId!
    await h.service.selectAccount(id)
    const original = h.getVault()
    h.setNative(JSON.stringify({ auth_method: 'consumer', token: { access_token: 'unknown' } }))
    const result = await h.service.listAccounts(false)
    expect(result.selectedAccountId).toBe(id)
    expect(result.currentAccount).toBeNull()
    expect(result.activeAccountId).toBeNull()
    expect(h.getVault()).toEqual(original)
  })

  it('rechecks selection after a pending native read while opted out', async () => {
    const h = harness()
    const id = (await h.service.addCurrentAccount()).activeAccountId!
    await h.service.selectAccount(id)
    const started = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    vi.mocked(h.backend.read).mockImplementationOnce(async () => {
      started.resolve()
      await gate.promise
      return parseAntigravityNativeCredential(credential('a', 2))
    })
    const listing = h.service.listAccounts(false)
    await started.promise
    const vault = h.getVault()
    vault.selectedAccountId = null
    h.store.write(vault)
    gate.resolve()
    expect((await listing).currentAccount).toBeNull()
    expect(h.getVault()).toEqual(vault)
  })

  it('keeps verified selected identity when opting out during a pending read', async () => {
    const h = harness()
    const id = (await h.service.addCurrentAccount()).activeAccountId!
    await h.service.selectAccount(id)
    const started = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    vi.mocked(h.backend.read).mockImplementationOnce(async () => {
      started.resolve()
      await gate.promise
      return parseAntigravityNativeCredential(credential('a', 2))
    })
    let enabled = true
    const listing = h.service.listAccounts(() => enabled)
    await started.promise
    enabled = false
    gate.resolve()
    const result = await listing
    expect(result.activeAccountId).toBe(id)
    expect(result.currentAccount?.subject).toBe('a')
  })

  it('keeps one stable account through access, refresh, expiry, ID-token and email rotation', async () => {
    const h = harness()
    const first = await h.service.addCurrentAccount()
    const id = first.activeAccountId
    const updated = credential('a', 2, 'renamed@example.invalid')
    h.setNative(updated)
    const refreshed = await h.service.listAccounts(true)
    expect(refreshed.accounts).toHaveLength(1)
    expect(refreshed.activeAccountId).toBe(id)
    expect(refreshed.accounts[0].email).toBe('renamed@example.invalid')
    expect(h.getVault().accounts[0].credentials).toBe(updated)
    expect((await h.service.addCurrentAccount()).accounts).toHaveLength(1)
    expect(JSON.stringify(refreshed)).not.toContain('synthetic-2')
    expect(JSON.stringify(refreshed)).not.toContain('refresh-2')
  })

  it('reconciles before switching away, and never restores a stale token on selecting the active account', async () => {
    const h = harness()
    const a = (await h.service.addCurrentAccount()).activeAccountId!
    h.setNative(credential('b'))
    const b = (await h.service.addCurrentAccount()).activeAccountId!
    h.setNative(credential('b', 2))
    await h.service.selectAccount(b)
    expect(h.backend.write).not.toHaveBeenCalled()
    expect(h.getVault().accounts.find((account) => account.id === b)?.credentials).toBe(
      credential('b', 2)
    )
    await h.service.selectAccount(a)
    expect(h.getNative()).toBe(credential('a'))
    await h.service.selectAccount(b)
    expect(h.getNative()).toBe(credential('b', 2))
  })

  it('persists selection and verifies it across service restart before launch', async () => {
    const h = harness()
    const id = (await h.service.addCurrentAccount()).activeAccountId!
    await h.service.selectAccount(id)
    const restarted = new AntigravityAccountService(h.store, h.backend)
    await restarted.prepareForLaunch()
    h.setNative(credential('another'))
    const state = await restarted.listAccounts(true)
    expect(state.selectedAccountId).toBe(id)
    expect(state.activeAccountId).toBeNull()
    await expect(restarted.prepareForLaunch()).rejects.toThrow('native Antigravity account changed')
    expect(h.backend.write).not.toHaveBeenCalled()
  })

  it('protects the current and selected account against deletion, including after external sign-out', async () => {
    const h = harness()
    const id = (await h.service.addCurrentAccount()).activeAccountId!
    await expect(h.service.removeAccount(id)).rejects.toThrow('Select another')
    await h.service.selectAccount(id)
    h.setNative(null)
    await expect(h.service.removeAccount(id)).rejects.toThrow('Select another')
    expect(h.getVault().accounts).toHaveLength(1)
  })

  it('does not fabricate a stable identity from rotating secrets or an email', async () => {
    const h = harness(
      JSON.stringify({
        auth_method: 'consumer',
        email: 'a@example.invalid',
        token: { access_token: 'unknown' }
      })
    )
    expect((await h.service.listAccounts(true)).currentAccount).toEqual({
      email: null,
      subject: null,
      authMethod: 'consumer',
      identityKnown: false
    })
    await expect(h.service.addCurrentAccount()).rejects.toThrow('no stable Google identity')
    expect(h.getVault().accounts).toHaveLength(0)
  })

  it('fails on native conflict without publishing a selection, and recovers the mutation queue', async () => {
    const h = harness()
    const id = (await h.service.addCurrentAccount()).activeAccountId!
    h.setNative(credential('b'))
    vi.mocked(h.backend.write).mockImplementationOnce(async () => {
      throw new Error('native conflict')
    })
    await expect(h.service.selectAccount(id)).rejects.toThrow('native conflict')
    expect(h.getVault().selectedAccountId).toBeNull()
    expect((await h.service.listAccounts(true)).currentAccount?.identityKnown).toBe(true)
  })

  it('does not trust write success when the native readback differs', async () => {
    const h = harness()
    const id = (await h.service.addCurrentAccount()).activeAccountId!
    h.setNative(credential('b'))
    vi.mocked(h.backend.write).mockResolvedValueOnce()
    await expect(h.service.selectAccount(id)).rejects.toThrow('could not be verified')
    expect(h.getVault().selectedAccountId).toBeNull()
  })

  it('serializes concurrent add, remove, select and external refresh reconciliation', async () => {
    const h = harness()
    const a = (await h.service.addCurrentAccount()).activeAccountId!
    h.setNative(credential('b'))
    const b = (await h.service.addCurrentAccount()).activeAccountId!
    h.setNative(credential('c'))
    const gate = Promise.withResolvers<void>()
    vi.mocked(h.backend.read).mockImplementationOnce(async () => {
      await gate.promise
      return parseAntigravityNativeCredential(credential('c'))
    })
    const add = h.service.addCurrentAccount()
    const remove = h.service.removeAccount(a)
    const select = h.service.selectAccount(b)
    const refresh = h.service.listAccounts(true)
    gate.resolve()
    const results = await Promise.all([add, remove, select, refresh])
    expect(results[3].accounts).toHaveLength(2)
    expect(results[3].accounts.some((account) => account.subject === 'c')).toBe(true)
    expect(results[3].activeAccountId).toBe(b)
    expect(h.getVault().accounts.some((account) => account.id === a)).toBe(false)
  })

  it('reads the latest vault after a native await so another persisted entry is not lost', async () => {
    const h = harness()
    await h.service.addCurrentAccount()
    const original = h.getVault()
    const gate = Promise.withResolvers<void>()
    vi.mocked(h.backend.read).mockImplementationOnce(async () => {
      await gate.promise
      return parseAntigravityNativeCredential(credential('a', 2))
    })
    const listing = h.service.listAccounts(true)
    await Promise.resolve()
    original.accounts.push({
      ...original.accounts[0],
      id: 'other',
      subject: 'b',
      credentials: credential('b')
    })
    h.store.write(original)
    gate.resolve()
    expect((await listing).accounts).toHaveLength(2)
    expect(h.getVault().accounts[0].credentials).toBe(credential('a', 2))
  })

  it('guards deletion when an external CLI selects the account during the final native check', async () => {
    const h = harness()
    const id = (await h.service.addCurrentAccount()).activeAccountId!
    h.setNative(credential('b'))
    vi.mocked(h.backend.read)
      .mockResolvedValueOnce(parseAntigravityNativeCredential(credential('b')))
      .mockResolvedValueOnce(parseAntigravityNativeCredential(credential('a', 2)))
    await expect(h.service.removeAccount(id)).rejects.toThrow('Select another')
    expect(h.getVault().accounts).toHaveLength(1)
  })
})
