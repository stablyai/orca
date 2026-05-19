import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
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

describe('anthropicApiKeyHandler.validate', () => {
  const originalFetch = global.fetch
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

  beforeEach(() => {
    readKeychainMock.mockReset()
    readKeychainMock.mockResolvedValue('sk-ant-test')
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('returns ok on 200', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200
    }) as unknown as typeof fetch
    const handler = createAnthropicApiKeyHandler()
    const result = await handler.validate(account)
    expect(result.ok).toBe(true)
  })

  it('hits GET /v1/models with x-api-key + anthropic-version headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    global.fetch = fetchMock as unknown as typeof fetch
    const handler = createAnthropicApiKeyHandler()
    await handler.validate(account)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/v1/models')
    expect(init.method).toBe('GET')
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-ant-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
  })

  it('returns reason + rescueHint on 401', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401
    }) as unknown as typeof fetch
    const handler = createAnthropicApiKeyHandler()
    const result = await handler.validate(account)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('API key invalid or revoked.')
    expect(result.rescueHint).toContain('Anthropic Console')
  })

  it('returns reason on 403', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403
    }) as unknown as typeof fetch
    const handler = createAnthropicApiKeyHandler()
    const result = await handler.validate(account)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('API key does not have Claude access.')
    expect(result.rescueHint).toContain('Anthropic Console')
  })

  it('returns network error on fetch rejection', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND')) as unknown as typeof fetch
    const handler = createAnthropicApiKeyHandler()
    const result = await handler.validate(account)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('Unable to reach the provider.')
    expect(result.rescueHint).toContain('network')
  })

  it('returns 5xx error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502
    }) as unknown as typeof fetch
    const handler = createAnthropicApiKeyHandler()
    const result = await handler.validate(account)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('Provider returned an error.')
  })

  it('returns timeout error when fetch aborts', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
    global.fetch = vi.fn().mockRejectedValue(abortErr) as unknown as typeof fetch
    const handler = createAnthropicApiKeyHandler()
    const result = await handler.validate(account)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toBe('Validation request timed out.')
  })

  it('returns missing-key error when keychain is empty', async () => {
    readKeychainMock.mockResolvedValueOnce(null)
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch
    const handler = createAnthropicApiKeyHandler()
    const result = await handler.validate(account)
    if (result.ok) throw new Error('expected fail')
    expect(result.reason).toContain('missing from Keychain')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
