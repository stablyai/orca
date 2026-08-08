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
    addAccountFromHome: vi.fn(() => Promise.resolve({ accounts: [], activeAccountId: 'a' })),
    selectAccount: vi.fn(() => Promise.resolve({ accounts: [], activeAccountId: null })),
    renameAccount: vi.fn(() => Promise.resolve({ accounts: [], activeAccountId: null })),
    removeAccount: vi.fn(() => Promise.resolve({ accounts: [], activeAccountId: null }))
  }
}

describe('managed provider home IPC', () => {
  it('keeps the selected source path inside main', async () => {
    const service = createService()
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/private/grok-home'] })
    const { registerManagedProviderHomeHandlers } = await import('./provider-managed-home-handlers')
    registerManagedProviderHomeHandlers('grokAccounts', service as never, 'Grok')

    const state = await handlers.get('grokAccounts:import')!({}, { label: 'Work' } as never)

    expect(service.addAccountFromHome).toHaveBeenCalledWith('/private/grok-home', 'Work')
    expect(JSON.stringify(state)).not.toContain('/private/grok-home')
  })

  it('rejects malformed labels before opening the directory picker', async () => {
    const service = createService()
    const { registerManagedProviderHomeHandlers } = await import('./provider-managed-home-handlers')
    registerManagedProviderHomeHandlers('geminiAccounts', service as never, 'Gemini')

    await expect(
      handlers.get('geminiAccounts:import')!({}, { label: 'line\nbreak' } as never)
    ).rejects.toThrow(/label/i)
    expect(showOpenDialog).not.toHaveBeenCalled()
  })
})
