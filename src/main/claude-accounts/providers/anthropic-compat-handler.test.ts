import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createAnthropicCompatHandler } from './anthropic-compat-handler'
import type { ClaudeManagedAccount } from '../../../shared/types'

const writeKeychainMock = vi.fn(async (_id: string, _value: string): Promise<void> => {})
const readKeychainMock = vi.fn(async (_id: string): Promise<string | null> => 'compat-key')

vi.mock('../keychain', () => ({
  writeManagedClaudeKeychainCredentials: (id: string, value: string) =>
    writeKeychainMock(id, value),
  readManagedClaudeKeychainCredentials: (id: string) => readKeychainMock(id)
}))

function compatAccount(
  preset: 'zai' | 'kimi' | 'minimax' | 'custom',
  baseUrl: string
): ClaudeManagedAccount {
  return {
    id: 'a1',
    email: `${preset} account`,
    managedAuthPath: '/tmp/a1/auth',
    authMethod: 'anthropic-compat',
    credentials: { authMethod: 'anthropic-compat', baseUrl, preset },
    modelMapping: {},
    fallbackAccountIds: [],
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

describe('anthropicCompatHandler.register', () => {
  beforeEach(() => writeKeychainMock.mockClear())

  it('zai preset uses baked baseUrl when input omits it', async () => {
    const handler = createAnthropicCompatHandler()
    const result = await handler.registerAccount({
      accountId: 'a1',
      managedAuthPath: '/tmp/a1/auth',
      label: 'GLM',
      secretFromUser: 'zai-token',
      providerConfig: { preset: 'zai' } as never
    })
    expect((result.credentials as { baseUrl: string }).baseUrl).toBe('https://api.z.ai/api/anthropic')
  })

  it('custom preset requires explicit baseUrl', async () => {
    const handler = createAnthropicCompatHandler()
    await expect(
      handler.registerAccount({
        accountId: 'a1',
        managedAuthPath: '/tmp/a1/auth',
        label: 'Custom',
        secretFromUser: 'token',
        providerConfig: { preset: 'custom' } as never
      })
    ).rejects.toThrow(/base url/i)
  })

  it('rejects empty secret', async () => {
    const handler = createAnthropicCompatHandler()
    await expect(
      handler.registerAccount({
        accountId: 'a1',
        managedAuthPath: '/tmp/a1/auth',
        label: 'GLM',
        secretFromUser: '',
        providerConfig: { preset: 'zai' } as never
      })
    ).rejects.toThrow(/token/i)
  })

  it('rejects missing preset', async () => {
    const handler = createAnthropicCompatHandler()
    await expect(
      handler.registerAccount({
        accountId: 'a1',
        managedAuthPath: '/tmp/a1/auth',
        label: 'No preset',
        secretFromUser: 'token'
      })
    ).rejects.toThrow(/preset/i)
  })
})

describe('anthropicCompatHandler.materialize', () => {
  it('emits ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN + model defaults for zai', async () => {
    const handler = createAnthropicCompatHandler()
    const out = await handler.materialize(compatAccount('zai', 'https://api.z.ai/api/anthropic'))
    expect(out.envPatch.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic')
    expect(out.envPatch.ANTHROPIC_AUTH_TOKEN).toBe('compat-key')
    expect(out.envPatch.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.1')
    expect(out.envPatch.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5.1')
    expect(out.envPatch.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-4.5-air')
  })

  it('emits kimi-k2.6 across tiers for kimi preset', async () => {
    const handler = createAnthropicCompatHandler()
    const out = await handler.materialize(compatAccount('kimi', 'https://api.moonshot.ai/anthropic'))
    expect(out.envPatch.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-k2.6')
    expect(out.envPatch.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-k2.6')
  })

  it('emits MiniMax-M2.7 and -highspeed for minimax preset', async () => {
    const handler = createAnthropicCompatHandler()
    const out = await handler.materialize(compatAccount('minimax', 'https://api.minimax.io/anthropic'))
    expect(out.envPatch.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('MiniMax-M2.7')
    expect(out.envPatch.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('MiniMax-M2.7-highspeed')
  })

  it('custom preset skips model env when modelMapping empty', async () => {
    const handler = createAnthropicCompatHandler()
    const out = await handler.materialize(compatAccount('custom', 'https://example.com'))
    expect(out.envPatch.ANTHROPIC_BASE_URL).toBe('https://example.com')
    expect(out.envPatch.ANTHROPIC_AUTH_TOKEN).toBe('compat-key')
    expect(out.envPatch.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined()
  })
})
