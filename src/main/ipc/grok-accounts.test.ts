import { describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

describe('registerGrokAccountHandlers', () => {
  it('rejects malformed account ids before calling the service', async () => {
    const { registerGrokAccountHandlers } = await import('./grok-accounts')
    const service = {
      listAccounts: vi.fn(),
      addAccount: vi.fn(),
      reauthenticateAccount: vi.fn(),
      removeAccount: vi.fn(),
      selectAccount: vi.fn()
    }

    registerGrokAccountHandlers(service as never)
    const reauthenticate = handlers.get('grokAccounts:reauthenticate')

    expect(reauthenticate).toBeDefined()
    expect(() => reauthenticate?.({}, undefined)).toThrow('Invalid Grok account id.')
    expect(service.reauthenticateAccount).not.toHaveBeenCalled()
  })

  it('allows selecting the system default account', async () => {
    const { registerGrokAccountHandlers } = await import('./grok-accounts')
    const service = {
      listAccounts: vi.fn(),
      addAccount: vi.fn(),
      reauthenticateAccount: vi.fn(),
      removeAccount: vi.fn(),
      selectAccount: vi.fn().mockResolvedValue({ accounts: [], activeAccountId: null })
    }

    registerGrokAccountHandlers(service as never)
    const select = handlers.get('grokAccounts:select')

    await select?.({}, { accountId: null })

    expect(service.selectAccount).toHaveBeenCalledWith(null)
  })
})
