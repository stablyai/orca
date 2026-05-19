import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createAzureFoundryHandler } from './azure-foundry-handler'
import type { ClaudeManagedAccount } from '../../../shared/types'

const writeKeychainMock = vi.fn(async (_id: string, _value: string): Promise<void> => {})
const readKeychainMock = vi.fn(async (_id: string): Promise<string | null> => 'foundry-key')

vi.mock('../keychain', () => ({
  writeManagedClaudeKeychainCredentials: (id: string, value: string) => writeKeychainMock(id, value),
  readManagedClaudeKeychainCredentials: (id: string) => readKeychainMock(id)
}))

function foundryAccount(overrides: Partial<ClaudeManagedAccount> = {}): ClaudeManagedAccount {
  return {
    id: 'a1',
    email: 'Foundry prod',
    managedAuthPath: '/tmp/a1/auth',
    authMethod: 'azure-foundry',
    credentials: { authMethod: 'azure-foundry', resource: 'prod-resource', useEntraId: false },
    modelMapping: {},
    fallbackAccountIds: [],
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0,
    ...overrides
  }
}

describe('azureFoundryHandler.registerAccount — API key path', () => {
  beforeEach(() => { writeKeychainMock.mockClear(); readKeychainMock.mockClear() })

  it('persists key + records resource in credentials', async () => {
    const handler = createAzureFoundryHandler()
    const result = await handler.registerAccount({
      accountId: 'a1',
      managedAuthPath: '/tmp/a1/auth',
      label: 'Foundry prod',
      secretFromUser: 'fkey-abc',
      providerConfig: { resource: 'prod-resource' } as never
    })
    expect(writeKeychainMock).toHaveBeenCalledWith('a1', 'fkey-abc')
    expect(result.credentials).toEqual({
      authMethod: 'azure-foundry',
      resource: 'prod-resource',
      useEntraId: false
    })
    expect(result.email).toBe('Foundry prod')
  })

  it('rejects when resource is missing', async () => {
    const handler = createAzureFoundryHandler()
    await expect(
      handler.registerAccount({
        accountId: 'a1',
        managedAuthPath: '/tmp/a1/auth',
        label: 'F',
        secretFromUser: 'fkey-abc',
        providerConfig: {} as never
      })
    ).rejects.toThrow(/resource/i)
  })

  it('rejects when secret is empty on API-key path', async () => {
    const handler = createAzureFoundryHandler()
    await expect(
      handler.registerAccount({
        accountId: 'a1',
        managedAuthPath: '/tmp/a1/auth',
        label: 'F',
        secretFromUser: '',
        providerConfig: { resource: 'r1' } as never
      })
    ).rejects.toThrow(/api key/i)
  })
})

describe('azureFoundryHandler.materialize — API key path', () => {
  it('emits CLAUDE_CODE_USE_FOUNDRY + FOUNDRY env keys, reads token from keychain', async () => {
    const handler = createAzureFoundryHandler()
    const out = await handler.materialize(foundryAccount())
    expect(out.envPatch.CLAUDE_CODE_USE_FOUNDRY).toBe('1')
    expect(out.envPatch.ANTHROPIC_FOUNDRY_RESOURCE).toBe('prod-resource')
    expect(out.envPatch.ANTHROPIC_FOUNDRY_API_KEY).toBe('foundry-key')
    expect(out.envPatch.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(out.configDirPath).toBeUndefined()
  })

  it('emits Anthropic-native model defaults', async () => {
    const handler = createAzureFoundryHandler()
    const out = await handler.materialize(foundryAccount())
    expect(out.envPatch.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4-7')
    expect(out.envPatch.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-sonnet-4-6')
    expect(out.envPatch.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5-20251001')
  })
})
