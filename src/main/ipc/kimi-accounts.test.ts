import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, args?: never) => unknown>()
const showOpenDialog = vi.fn()
const showMessageBox = vi.fn()
const openExternal = vi.fn()

vi.mock('electron', () => ({
  dialog: { showOpenDialog, showMessageBox },
  shell: { openExternal },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args?: never) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

beforeEach(() => {
  handlers.clear()
  showOpenDialog.mockReset()
  showMessageBox.mockReset()
  openExternal.mockReset()
})

function createService() {
  return {
    listAccounts: vi.fn(() => ({ accounts: [], activeAccountId: null })),
    addAccountFromHome: vi.fn(() =>
      Promise.resolve({ accounts: [], activeAccountId: 'account-a' })
    ),
    addAccountWithLogin: vi.fn(
      async (_label: string, onInstructions: (instructions: unknown) => Promise<unknown>) => {
        await onInstructions({
          verificationUrl: 'https://auth.kimi.com/device',
          message: 'Open the browser and enter code ABCD-EFGH.'
        })
        return { accounts: [], activeAccountId: 'account-a' }
      }
    ),
    selectAccount: vi.fn(() => Promise.resolve({ accounts: [], activeAccountId: null })),
    renameAccount: vi.fn(() => Promise.resolve({ accounts: [], activeAccountId: null })),
    removeAccount: vi.fn(() => Promise.resolve({ accounts: [], activeAccountId: null }))
  }
}

function createRateLimits() {
  return {
    refreshForKimiAccountChange: vi.fn(() => Promise.resolve()),
    evictInactiveKimiCache: vi.fn()
  }
}

describe('Kimi account IPC', () => {
  it('opens only the HTTPS verification URL and never returns credentials', async () => {
    const service = createService()
    const rateLimits = createRateLimits()
    showMessageBox.mockResolvedValue({ response: 0 })
    openExternal.mockResolvedValue(undefined)
    const { registerKimiAccountHandlers } = await import('./kimi-accounts')
    registerKimiAccountHandlers(service as never, rateLimits as never)

    const state = await handlers.get('kimiAccounts:login')!({}, { label: 'Work' } as never)

    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: 'Open the browser and enter code ABCD-EFGH.',
        buttons: ['Open browser', 'Cancel']
      })
    )
    expect(openExternal).toHaveBeenCalledWith('https://auth.kimi.com/device')
    expect(JSON.stringify(state)).not.toContain('token')
    expect(rateLimits.refreshForKimiAccountChange).toHaveBeenCalledWith(null)
  })

  it('keeps the selected source path inside main and passes only it to the service', async () => {
    const service = createService()
    const rateLimits = createRateLimits()
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/private/kimi-home'] })
    const { registerKimiAccountHandlers } = await import('./kimi-accounts')
    registerKimiAccountHandlers(service as never, rateLimits as never)

    await handlers.get('kimiAccounts:import')!({}, { label: 'Work' } as never)

    expect(showOpenDialog).toHaveBeenCalledWith({
      title: 'Select an existing Kimi Code home',
      properties: ['openDirectory']
    })
    expect(service.addAccountFromHome).toHaveBeenCalledWith('/private/kimi-home', 'Work')
    expect(rateLimits.refreshForKimiAccountChange).toHaveBeenCalledWith(null)
  })

  it('rejects an invalid label before opening the directory picker', async () => {
    const service = createService()
    const rateLimits = createRateLimits()
    const { registerKimiAccountHandlers } = await import('./kimi-accounts')
    registerKimiAccountHandlers(service as never, rateLimits as never)

    await expect(
      handlers.get('kimiAccounts:import')!({}, { label: 'line\nbreak' } as never)
    ).rejects.toThrow(/label/i)
    expect(showOpenDialog).not.toHaveBeenCalled()
  })

  it('does not import when the directory picker is cancelled', async () => {
    const service = createService()
    const rateLimits = createRateLimits()
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    const { registerKimiAccountHandlers } = await import('./kimi-accounts')
    registerKimiAccountHandlers(service as never, rateLimits as never)

    await expect(
      handlers.get('kimiAccounts:import')!({}, { label: 'Work' } as never)
    ).rejects.toThrow(/cancelled/i)
    expect(service.addAccountFromHome).not.toHaveBeenCalled()
  })

  it('routes list, selection, rename, and removal without exposing account homes', async () => {
    const service = createService()
    const rateLimits = createRateLimits()
    const { registerKimiAccountHandlers } = await import('./kimi-accounts')
    registerKimiAccountHandlers(service as never, rateLimits as never)

    handlers.get('kimiAccounts:list')!({})
    await handlers.get('kimiAccounts:select')!({}, { accountId: null } as never)
    await handlers.get('kimiAccounts:rename')!({}, {
      accountId: 'account-a',
      label: 'Personal'
    } as never)
    await handlers.get('kimiAccounts:remove')!({}, { accountId: 'account-a' } as never)

    expect(service.listAccounts).toHaveBeenCalledTimes(3)
    expect(service.selectAccount).toHaveBeenCalledWith(null)
    expect(service.renameAccount).toHaveBeenCalledWith('account-a', 'Personal')
    expect(service.removeAccount).toHaveBeenCalledWith('account-a')
    expect(rateLimits.refreshForKimiAccountChange).toHaveBeenCalledWith(null)
    expect(rateLimits.evictInactiveKimiCache).toHaveBeenCalledWith('account-a')
  })
})
