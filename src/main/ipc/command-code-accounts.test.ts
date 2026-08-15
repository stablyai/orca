import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, args?: never) => unknown>()
const showOpenDialog = vi.fn()

vi.mock('electron', () => ({
  dialog: { showOpenDialog },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args?: never) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

beforeEach(() => {
  handlers.clear()
  showOpenDialog.mockReset()
})

function createService() {
  return {
    listAccounts: vi.fn(() => ({ accounts: [], activeAccountId: null })),
    addAccountFromHome: vi.fn(() =>
      Promise.resolve({ accounts: [], activeAccountId: 'account-a' })
    ),
    selectAccount: vi.fn(() => Promise.resolve({ accounts: [], activeAccountId: null })),
    renameAccount: vi.fn(() => Promise.resolve({ accounts: [], activeAccountId: null })),
    removeAccount: vi.fn(() => Promise.resolve({ accounts: [], activeAccountId: null }))
  }
}

describe('Command Code account IPC', () => {
  it('keeps the selected source path inside main', async () => {
    const service = createService()
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/private/command-code-home']
    })
    const { registerCommandCodeAccountHandlers } = await import('./command-code-accounts')
    registerCommandCodeAccountHandlers(service as never)

    const state = await handlers.get('commandCodeAccounts:import')!({}, { label: 'Work' } as never)

    expect(service.addAccountFromHome).toHaveBeenCalledWith('/private/command-code-home', 'Work')
    expect(JSON.stringify(state)).not.toContain('/private/command-code-home')
  })

  it('rejects invalid input before opening the directory picker', async () => {
    const service = createService()
    const { registerCommandCodeAccountHandlers } = await import('./command-code-accounts')
    registerCommandCodeAccountHandlers(service as never)

    await expect(
      handlers.get('commandCodeAccounts:import')!({}, { label: 'line\nbreak' } as never)
    ).rejects.toThrow(/label/i)
    expect(showOpenDialog).not.toHaveBeenCalled()
  })

  it('does not import when the directory picker is cancelled', async () => {
    const service = createService()
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    const { registerCommandCodeAccountHandlers } = await import('./command-code-accounts')
    registerCommandCodeAccountHandlers(service as never)

    await expect(
      handlers.get('commandCodeAccounts:import')!({}, { label: 'Work' } as never)
    ).rejects.toThrow(/cancelled/i)
    expect(service.addAccountFromHome).not.toHaveBeenCalled()
  })

  it('routes list, selection, rename, and removal', async () => {
    const service = createService()
    const { registerCommandCodeAccountHandlers } = await import('./command-code-accounts')
    registerCommandCodeAccountHandlers(service as never)

    handlers.get('commandCodeAccounts:list')!({})
    await handlers.get('commandCodeAccounts:select')!({}, { accountId: null } as never)
    await handlers.get('commandCodeAccounts:rename')!({}, {
      accountId: 'account-a',
      label: 'Personal'
    } as never)
    await handlers.get('commandCodeAccounts:remove')!({}, { accountId: 'account-a' } as never)

    expect(service.listAccounts).toHaveBeenCalledOnce()
    expect(service.selectAccount).toHaveBeenCalledWith(null)
    expect(service.renameAccount).toHaveBeenCalledWith('account-a', 'Personal')
    expect(service.removeAccount).toHaveBeenCalledWith('account-a')
  })
})
