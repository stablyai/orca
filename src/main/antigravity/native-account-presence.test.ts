import { describe, expect, it, vi } from 'vitest'
import { AntigravityAccountService } from './native-account-service'
import { credential, harness } from './native-account-test-fixtures'

describe('Antigravity selected account presence', () => {
  it('loads lazily and reads the vault only once on repeated presence checks', () => {
    const h = harness()
    expect(h.store.read).not.toHaveBeenCalled()
    expect(h.service.hasSelectedAccount()).toBe(false)
    expect(h.service.hasSelectedAccount()).toBe(false)
    expect(h.store.read).toHaveBeenCalledOnce()
    expect(h.backend.read).not.toHaveBeenCalled()
  })

  it('recognizes persisted selection without inspecting the native backend', async () => {
    const h = harness()
    const id = (await h.service.addCurrentAccount()).activeAccountId!
    await h.service.selectAccount(id)
    const restarted = new AntigravityAccountService(h.store, h.backend)
    vi.mocked(h.store.read).mockClear()
    vi.mocked(h.backend.read).mockClear()
    expect(restarted.hasSelectedAccount()).toBe(true)
    expect(restarted.hasSelectedAccount()).toBe(true)
    expect(h.store.read).toHaveBeenCalledOnce()
    expect(h.backend.read).not.toHaveBeenCalled()
  })

  it('reflects add, select and remove without extra vault reads', async () => {
    const h = harness()
    expect(h.service.hasSelectedAccount()).toBe(false)
    const a = (await h.service.addCurrentAccount()).activeAccountId!
    expect(h.service.hasSelectedAccount()).toBe(false)
    await h.service.selectAccount(a)
    expect(h.service.hasSelectedAccount()).toBe(true)
    h.setNative(credential('b'))
    const b = (await h.service.addCurrentAccount()).activeAccountId!
    await h.service.selectAccount(b)
    await h.service.removeAccount(a)
    vi.mocked(h.store.read).mockClear()
    expect(h.service.hasSelectedAccount()).toBe(true)
    expect(h.store.read).not.toHaveBeenCalled()
  })

  it('refreshes presence on opted-out lists, including their early return', async () => {
    const h = harness()
    const id = (await h.service.addCurrentAccount()).activeAccountId!
    await h.service.selectAccount(id)
    const vault = h.getVault()
    vault.selectedAccountId = null
    h.store.write(vault)
    await h.service.listAccounts(false)
    expect(h.service.hasSelectedAccount()).toBe(false)
    vault.selectedAccountId = id
    h.store.write(vault)
    h.setNative(null)
    await h.service.listAccounts(false)
    expect(h.service.hasSelectedAccount()).toBe(true)
  })

  it('refreshes presence during reconciliation even when the operation fails', async () => {
    const h = harness()
    const id = (await h.service.addCurrentAccount()).activeAccountId!
    await h.service.selectAccount(id)
    const vault = h.getVault()
    vault.selectedAccountId = null
    h.store.write(vault)
    await expect(h.service.selectAccount('missing')).rejects.toThrow('not found')
    expect(h.service.hasSelectedAccount()).toBe(false)
  })

  it('fails closed once on an unreadable vault and recovers through a later list', async () => {
    const h = harness()
    const id = (await h.service.addCurrentAccount()).activeAccountId!
    await h.service.selectAccount(id)
    const restarted = new AntigravityAccountService(h.store, h.backend)
    vi.mocked(h.store.read)
      .mockClear()
      .mockImplementationOnce(() => {
        throw new Error('unreadable vault')
      })
    expect(restarted.hasSelectedAccount()).toBe(false)
    expect(restarted.hasSelectedAccount()).toBe(false)
    expect(h.store.read).toHaveBeenCalledOnce()
    await restarted.listAccounts(false)
    expect(restarted.hasSelectedAccount()).toBe(true)
    vi.mocked(h.store.read).mockImplementationOnce(() => {
      throw new Error('unreadable vault')
    })
    await expect(restarted.listAccounts(false)).rejects.toThrow('unreadable vault')
    expect(restarted.hasSelectedAccount()).toBe(false)
    await restarted.listAccounts(false)
    expect(restarted.hasSelectedAccount()).toBe(true)
  })

  it('does not publish selection when saving the vault fails', async () => {
    const h = harness()
    const id = (await h.service.addCurrentAccount()).activeAccountId!
    vi.mocked(h.store.write).mockImplementationOnce(() => {
      throw new Error('cannot save vault')
    })
    await expect(h.service.selectAccount(id)).rejects.toThrow('cannot save vault')
    expect(h.service.hasSelectedAccount()).toBe(false)
    await h.service.selectAccount(id)
    expect(h.service.hasSelectedAccount()).toBe(true)
  })

  it('requires the selected ID to belong to a saved account', () => {
    const h = harness()
    h.store.write({ accounts: [], selectedAccountId: 'missing' })
    expect(h.service.hasSelectedAccount()).toBe(false)
  })
})
