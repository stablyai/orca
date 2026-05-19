import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const writeKeychainMock = vi.fn(async (_id: string, _value: string): Promise<void> => {})
const readKeychainMock = vi.fn(async (_id: string): Promise<string | null> => 'compat-key')

vi.mock('../keychain', () => ({
  writeManagedClaudeKeychainCredentials: (id: string, value: string) =>
    writeKeychainMock(id, value),
  readManagedClaudeKeychainCredentials: (id: string) => readKeychainMock(id)
}))

// Why: keep handler.materialize tests deterministic — never hit the real
// registry network or fs cache. Default to null (= baked fallback); per-test
// overrides can install registry overrides.
vi.mock('../preset-registry', () => ({
  fetchPresetRegistry: vi.fn(async () => null)
}))

import { fetchPresetRegistry } from '../preset-registry'
import { createAnthropicCompatHandler } from './anthropic-compat-handler'
import type { ClaudeManagedAccount } from '../../../shared/types'

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

  it('preset registry override beats baked defaults for zai', async () => {
    vi.mocked(fetchPresetRegistry).mockResolvedValueOnce({
      version: 1,
      presets: { zai: { opus: 'glm-7.0', sonnet: 'glm-7.0', haiku: 'glm-air-2' } }
    })
    const handler = createAnthropicCompatHandler()
    const out = await handler.materialize(compatAccount('zai', 'https://api.z.ai/api/anthropic'))
    expect(out.envPatch.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-7.0')
    expect(out.envPatch.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-7.0')
    expect(out.envPatch.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-air-2')
  })

  it('falls back to baked defaults when registry returns null', async () => {
    vi.mocked(fetchPresetRegistry).mockResolvedValueOnce(null)
    const handler = createAnthropicCompatHandler()
    const out = await handler.materialize(compatAccount('zai', 'https://api.z.ai/api/anthropic'))
    expect(out.envPatch.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-5.1')
    expect(out.envPatch.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-4.5-air')
  })
})

describe('anthropicCompatHandler.validate', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    readKeychainMock.mockReset()
    readKeychainMock.mockResolvedValue('compat-key')
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('returns ok on 200', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch
    const handler = createAnthropicCompatHandler()
    const result = await handler.validate(compatAccount('zai', 'https://api.z.ai/api/anthropic'))
    expect(result.ok).toBe(true)
  })

  it('hits {baseUrl}/v1/models with x-api-key + anthropic-version headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    global.fetch = fetchMock as unknown as typeof fetch
    const handler = createAnthropicCompatHandler()
    await handler.validate(compatAccount('zai', 'https://api.z.ai/api/anthropic'))
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.z.ai/api/anthropic/v1/models')
    expect(init.method).toBe('GET')
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('compat-key')
    expect(headers['anthropic-version']).toBe('2023-06-01')
  })

  it('strips trailing slash from baseUrl before /v1/models', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    global.fetch = fetchMock as unknown as typeof fetch
    const handler = createAnthropicCompatHandler()
    await handler.validate(compatAccount('custom', 'https://proxy.example/'))
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe('https://proxy.example/v1/models')
  })

  it('returns provider-generic rescueHint on 401', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 }) as unknown as typeof fetch
    const handler = createAnthropicCompatHandler()
    const result = await handler.validate(compatAccount('zai', 'https://api.z.ai/api/anthropic'))
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('Provider token invalid or revoked.')
    expect(result.rescueHint).toContain("provider's dashboard")
  })

  it('returns reason on 403', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 }) as unknown as typeof fetch
    const handler = createAnthropicCompatHandler()
    const result = await handler.validate(compatAccount('zai', 'https://api.z.ai/api/anthropic'))
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('API key does not have Claude access.')
  })

  it('returns network error on fetch rejection', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND')) as unknown as typeof fetch
    const handler = createAnthropicCompatHandler()
    const result = await handler.validate(compatAccount('zai', 'https://api.z.ai/api/anthropic'))
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('Unable to reach the provider.')
  })

  it('returns 5xx error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 502 }) as unknown as typeof fetch
    const handler = createAnthropicCompatHandler()
    const result = await handler.validate(compatAccount('zai', 'https://api.z.ai/api/anthropic'))
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('Provider returned an error.')
  })

  it('returns missing-token error when keychain is empty', async () => {
    readKeychainMock.mockResolvedValueOnce(null)
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch
    const handler = createAnthropicCompatHandler()
    const result = await handler.validate(compatAccount('zai', 'https://api.z.ai/api/anthropic'))
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toContain('missing from Keychain')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
