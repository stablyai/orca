import { describe, expect, it, vi, beforeEach } from 'vitest'

import { registerClaudeAccountHandlers } from './claude-accounts'

// Why: cover the claudeAccounts:add IPC handler — it must accept an optional
// polymorphic AddClaudeAccountInput and pass it straight through to
// ClaudeAccountService.addAccount. The legacy no-arg OAuth path must continue
// to work for callers that haven't migrated yet.

const handleHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handleHandlers.set(channel, handler)
    }
  }
}))

beforeEach(() => {
  handleHandlers.clear()
})

function makeServiceStub(): {
  service: Parameters<typeof registerClaudeAccountHandlers>[0]
  addAccount: ReturnType<typeof vi.fn>
  validateAccount: ReturnType<typeof vi.fn>
} {
  const addAccount = vi.fn().mockResolvedValue({ accounts: [], activeAccountId: null })
  const validateAccount = vi.fn().mockResolvedValue({ ok: true })
  const service = {
    listAccounts: vi.fn(),
    addAccount,
    reauthenticateAccount: vi.fn(),
    removeAccount: vi.fn(),
    selectAccount: vi.fn(),
    validateAccount
  } as unknown as Parameters<typeof registerClaudeAccountHandlers>[0]
  return { service, addAccount, validateAccount }
}

describe('claudeAccounts:add IPC', () => {
  it('forwards no input to addAccount when called with undefined (legacy OAuth path)', async () => {
    const { service, addAccount } = makeServiceStub()
    registerClaudeAccountHandlers(service)

    const handler = handleHandlers.get('claudeAccounts:add')
    expect(handler).toBeDefined()

    await handler!({}, undefined)

    expect(addAccount).toHaveBeenCalledTimes(1)
    expect(addAccount).toHaveBeenCalledWith(undefined)
  })

  it('forwards a polymorphic anthropic-api-key input to addAccount', async () => {
    const { service, addAccount } = makeServiceStub()
    registerClaudeAccountHandlers(service)

    const handler = handleHandlers.get('claudeAccounts:add')!
    const input = {
      authMethod: 'anthropic-api-key' as const,
      label: 'work',
      secretFromUser: 'sk-ant-xxx'
    }

    await handler({}, input)

    expect(addAccount).toHaveBeenCalledWith(input)
  })

  it('forwards a polymorphic anthropic-compat input to addAccount', async () => {
    const { service, addAccount } = makeServiceStub()
    registerClaudeAccountHandlers(service)

    const handler = handleHandlers.get('claudeAccounts:add')!
    const input = {
      authMethod: 'anthropic-compat' as const,
      label: 'zai',
      secretFromUser: 'token-123',
      providerConfig: { preset: 'zai' as const }
    }

    await handler({}, input)

    expect(addAccount).toHaveBeenCalledWith(input)
  })
})

describe('claudeAccounts:validate IPC', () => {
  it('forwards the accountId to service.validateAccount and returns its result', async () => {
    const { service, validateAccount } = makeServiceStub()
    validateAccount.mockResolvedValueOnce({ ok: true })
    registerClaudeAccountHandlers(service)

    const handler = handleHandlers.get('claudeAccounts:validate')
    expect(handler).toBeDefined()

    const result = await handler!({}, { accountId: 'a1' })

    expect(validateAccount).toHaveBeenCalledWith('a1')
    expect(result).toEqual({ ok: true })
  })

  it('returns "Account not found." when the service throws', async () => {
    const { service, validateAccount } = makeServiceStub()
    validateAccount.mockRejectedValueOnce(new Error('That Claude account no longer exists.'))
    registerClaudeAccountHandlers(service)

    const handler = handleHandlers.get('claudeAccounts:validate')!
    const result = await handler({}, { accountId: 'missing' })

    expect(result).toEqual({ ok: false, reason: 'Account not found.' })
  })

  it('forwards a failure ValidationResult through verbatim', async () => {
    const { service, validateAccount } = makeServiceStub()
    validateAccount.mockResolvedValueOnce({
      ok: false,
      reason: 'API key invalid or revoked.',
      rescueHint: 'Generate a new key in the Anthropic Console and try again.'
    })
    registerClaudeAccountHandlers(service)

    const handler = handleHandlers.get('claudeAccounts:validate')!
    const result = await handler({}, { accountId: 'a1' })
    expect(result).toEqual({
      ok: false,
      reason: 'API key invalid or revoked.',
      rescueHint: 'Generate a new key in the Anthropic Console and try again.'
    })
  })
})
