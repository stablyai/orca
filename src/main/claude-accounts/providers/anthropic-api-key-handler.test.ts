import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createAnthropicApiKeyHandler } from './anthropic-api-key-handler'
import type { ClaudeManagedAccount } from '../../../shared/types'

const writeKeychainMock = vi.fn(async (_id: string, _value: string): Promise<void> => {})
const readKeychainMock = vi.fn(async (_id: string): Promise<string | null> => 'sk-ant-test-key')

vi.mock('../keychain', () => ({
  writeManagedClaudeKeychainCredentials: (id: string, value: string) =>
    writeKeychainMock(id, value),
  readManagedClaudeKeychainCredentials: (id: string) => readKeychainMock(id)
}))

describe('anthropicApiKeyHandler', () => {
  beforeEach(() => {
    writeKeychainMock.mockClear()
    readKeychainMock.mockClear()
  })

  it('register persists the key to keychain and returns label as email', async () => {
    const handler = createAnthropicApiKeyHandler()
    const result = await handler.registerAccount({
      accountId: 'a1',
      managedAuthPath: '/tmp/a1/auth',
      label: 'Work API key',
      secretFromUser: 'sk-ant-abc123'
    })
    expect(writeKeychainMock).toHaveBeenCalledWith('a1', 'sk-ant-abc123')
    expect(result.email).toBe('Work API key')
    expect(result.credentials).toEqual({ authMethod: 'anthropic-api-key' })
  })

  it('register rejects empty key', async () => {
    const handler = createAnthropicApiKeyHandler()
    await expect(
      handler.registerAccount({
        accountId: 'a1',
        managedAuthPath: '/tmp/a1/auth',
        secretFromUser: ''
      })
    ).rejects.toThrow(/api key/i)
  })

  it('materialize reads key from keychain and emits ANTHROPIC_API_KEY', async () => {
    const handler = createAnthropicApiKeyHandler()
    const account: ClaudeManagedAccount = {
      id: 'a1',
      email: 'Work',
      managedAuthPath: '/tmp/a1/auth',
      authMethod: 'anthropic-api-key',
      credentials: { authMethod: 'anthropic-api-key' },
      modelMapping: {},
      fallbackAccountIds: [],
      createdAt: 0,
      updatedAt: 0,
      lastAuthenticatedAt: 0
    }
    const result = await handler.materialize(account)
    expect(result.envPatch.ANTHROPIC_API_KEY).toBe('sk-ant-test-key')
    expect(result.configDirPath).toBeUndefined()
  })

  it('materialize emits ANTHROPIC_DEFAULT_*_MODEL when modelMapping overrides set', async () => {
    const handler = createAnthropicApiKeyHandler()
    const account: ClaudeManagedAccount = {
      id: 'a1',
      email: 'Work',
      managedAuthPath: '/tmp/a1/auth',
      authMethod: 'anthropic-api-key',
      credentials: { authMethod: 'anthropic-api-key' },
      modelMapping: {
        opus: 'claude-opus-4-7',
        sonnet: 'claude-sonnet-4-6',
        haiku: 'claude-haiku-4-5-20251001'
      },
      fallbackAccountIds: [],
      createdAt: 0,
      updatedAt: 0,
      lastAuthenticatedAt: 0
    }
    const result = await handler.materialize(account)
    expect(result.envPatch.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4-7')
    expect(result.envPatch.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-sonnet-4-6')
    expect(result.envPatch.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5-20251001')
  })

  it('materialize falls back to provider defaults when modelMapping empty', async () => {
    const handler = createAnthropicApiKeyHandler()
    const account: ClaudeManagedAccount = {
      id: 'a1',
      email: 'Work',
      managedAuthPath: '/tmp/a1/auth',
      authMethod: 'anthropic-api-key',
      credentials: { authMethod: 'anthropic-api-key' },
      modelMapping: {},
      fallbackAccountIds: [],
      createdAt: 0,
      updatedAt: 0,
      lastAuthenticatedAt: 0
    }
    const result = await handler.materialize(account)
    expect(result.envPatch.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4-7')
    expect(result.envPatch.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-sonnet-4-6')
    expect(result.envPatch.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5-20251001')
  })

  it('materialize throws when keychain returns null', async () => {
    readKeychainMock.mockResolvedValueOnce(null as never)
    const handler = createAnthropicApiKeyHandler()
    const account: ClaudeManagedAccount = {
      id: 'a1',
      email: 'Work',
      managedAuthPath: '/tmp/a1/auth',
      authMethod: 'anthropic-api-key',
      credentials: { authMethod: 'anthropic-api-key' },
      modelMapping: {},
      fallbackAccountIds: [],
      createdAt: 0,
      updatedAt: 0,
      lastAuthenticatedAt: 0
    }
    await expect(handler.materialize(account)).rejects.toThrow(/missing from keychain/i)
  })
})
