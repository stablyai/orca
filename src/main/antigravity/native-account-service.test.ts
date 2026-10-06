import { describe, expect, it, vi } from 'vitest'
import { AntigravityAccountService } from './native-account-service'
import { parseAntigravityNativeCredential } from './native-credential-codec'
import { credential, harness } from './native-account-test-fixtures'

describe('Antigravity native account identity and selection', () => {
  it('keeps one stable account through access, refresh, expiry, ID-token and email rotation', async () => {
    const h = harness()
    const first = await h.service.addCurrentAccount()
    const id = first.activeAccountId
    const updated = credential('a', 2, 'renamed@example.invalid')
    h.setNative(updated)
    const refreshed = await h.service.listAccounts()
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
    const state = await restarted.listAccounts()
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
    expect((await h.service.listAccounts()).currentAccount).toEqual({
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
    expect((await h.service.listAccounts()).currentAccount?.identityKnown).toBe(true)
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
    const refresh = h.service.listAccounts()
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
    const listing = h.service.listAccounts()
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

describe('asynchronous account storage', () => {
  it('waits for the snapshot write and propagates failure before reporting success', async () => {
    const h = harness()
    let rejectWrite: ((error: Error) => void) | undefined
    const service = new AntigravityAccountService(
      {
        read: async () => h.getVault(),
        write: () =>
          new Promise<void>((_, reject) => {
            rejectWrite = reject
          })
      },
      h.backend
    )
    const pending = service.addCurrentAccount()
    const failed = expect(pending).rejects.toThrow('disk unavailable')
    await vi.waitFor(() => expect(rejectWrite).toBeTypeOf('function'))
    rejectWrite?.(new Error('disk unavailable'))
    await failed
  })
  it('does not run an expired queued mutation', async () => {
    const h = harness()
    const id = (await h.service.addCurrentAccount()).activeAccountId!
    const controller = new AbortController()
    controller.abort()
    await expect(
      h.service.selectAccount(id, { deadline: Date.now() - 1, signal: controller.signal })
    ).rejects.toThrow('timed out')
    expect(h.backend.write).not.toHaveBeenCalled()
  })
})
