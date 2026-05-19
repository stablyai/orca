import { describe, expect, it, vi, beforeEach } from 'vitest'
import { CLAUDE_ACCOUNTS_HANDLERS } from './claude-accounts'
import { RuntimeClientError } from '../runtime-client'

const callMock = vi.fn()
const buildCtx = (flags: Record<string, string | boolean>) => ({
  flags: new Map(Object.entries(flags)),
  client: { call: callMock } as never,
  cwd: '/tmp',
  json: true
})

let logSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  callMock.mockReset()
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  delete process.env.SECRET_ENV
})

describe('claude-accounts add — anthropic-api-key', () => {
  it('reads key from env var named by --key-env (never argv)', async () => {
    process.env.SECRET_ENV = 'sk-ant-real'
    callMock.mockResolvedValueOnce({
      result: { accountId: 'acct-1', email: 'Work', accounts: [], activeAccountId: 'acct-1' }
    })
    await CLAUDE_ACCOUNTS_HANDLERS['claude-accounts add'](
      buildCtx({ provider: 'anthropic-api-key', label: 'Work', 'key-env': 'SECRET_ENV' })
    )
    expect(callMock).toHaveBeenCalledWith('claudeAccounts.add', {
      authMethod: 'anthropic-api-key',
      label: 'Work',
      secretFromUser: 'sk-ant-real'
    })
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ ok: true, accountId: 'acct-1', email: 'Work' })
    )
  })

  it('throws when --key-env names an unset env var', async () => {
    await expect(
      CLAUDE_ACCOUNTS_HANDLERS['claude-accounts add'](
        buildCtx({ provider: 'anthropic-api-key', label: 'Work', 'key-env': 'NOT_SET' })
      )
    ).rejects.toThrow(/NOT_SET/)
  })

  it('rejects --provider unknown', async () => {
    await expect(
      CLAUDE_ACCOUNTS_HANDLERS['claude-accounts add'](buildCtx({ provider: 'martian' }))
    ).rejects.toBeInstanceOf(RuntimeClientError)
  })
})

describe('claude-accounts add — anthropic-compat', () => {
  it('preset zai uses default base URL and --token-env', async () => {
    process.env.SECRET_ENV = 'zai-token'
    callMock.mockResolvedValueOnce({
      result: { accountId: 'acct-2', email: 'GLM', accounts: [], activeAccountId: 'acct-2' }
    })
    await CLAUDE_ACCOUNTS_HANDLERS['claude-accounts add'](
      buildCtx({
        provider: 'anthropic-compat',
        preset: 'zai',
        label: 'GLM',
        'token-env': 'SECRET_ENV'
      })
    )
    expect(callMock).toHaveBeenCalledWith('claudeAccounts.add', {
      authMethod: 'anthropic-compat',
      label: 'GLM',
      secretFromUser: 'zai-token',
      providerConfig: { preset: 'zai' }
    })
  })

  it('preset custom requires --base-url', async () => {
    process.env.SECRET_ENV = 'tok'
    await expect(
      CLAUDE_ACCOUNTS_HANDLERS['claude-accounts add'](
        buildCtx({
          provider: 'anthropic-compat',
          preset: 'custom',
          label: 'Custom',
          'token-env': 'SECRET_ENV'
        })
      )
    ).rejects.toThrow(/--base-url/i)
  })

  it('preset custom with --base-url emits providerConfig.baseUrl', async () => {
    process.env.SECRET_ENV = 'tok'
    callMock.mockResolvedValueOnce({
      result: { accountId: 'acct-3', email: 'Custom', accounts: [], activeAccountId: 'acct-3' }
    })
    await CLAUDE_ACCOUNTS_HANDLERS['claude-accounts add'](
      buildCtx({
        provider: 'anthropic-compat',
        preset: 'custom',
        'base-url': 'https://x',
        label: 'Custom',
        'token-env': 'SECRET_ENV'
      })
    )
    expect(callMock).toHaveBeenCalledWith('claudeAccounts.add', {
      authMethod: 'anthropic-compat',
      label: 'Custom',
      secretFromUser: 'tok',
      providerConfig: { preset: 'custom', baseUrl: 'https://x' }
    })
  })
})

describe('claude-accounts add — azure-foundry', () => {
  it('--use-entra-id sends authMode entra without secret env', async () => {
    callMock.mockResolvedValueOnce({
      result: { accountId: 'acct-az', email: 'myres', accounts: [], activeAccountId: 'acct-az' }
    })
    await CLAUDE_ACCOUNTS_HANDLERS['claude-accounts add'](
      buildCtx({
        provider: 'azure-foundry',
        resource: 'myres',
        'use-entra-id': true
      })
    )
    expect(callMock).toHaveBeenCalledWith('claudeAccounts.add', {
      authMethod: 'azure-foundry',
      label: 'myres',
      providerConfig: { resource: 'myres', authMode: 'entra-id' }
    })
  })

  it('API-key mode reads from --key-env', async () => {
    process.env.SECRET_ENV = 'az-key'
    callMock.mockResolvedValueOnce({
      result: { accountId: 'acct-az2', email: 'myres', accounts: [], activeAccountId: 'acct-az2' }
    })
    await CLAUDE_ACCOUNTS_HANDLERS['claude-accounts add'](
      buildCtx({
        provider: 'azure-foundry',
        resource: 'myres',
        'key-env': 'SECRET_ENV'
      })
    )
    expect(callMock).toHaveBeenCalledWith('claudeAccounts.add', {
      authMethod: 'azure-foundry',
      label: 'myres',
      secretFromUser: 'az-key',
      providerConfig: { resource: 'myres', authMode: 'api-key' }
    })
  })

  it('rejects azure-foundry without --resource', async () => {
    await expect(
      CLAUDE_ACCOUNTS_HANDLERS['claude-accounts add'](
        buildCtx({ provider: 'azure-foundry', 'use-entra-id': true })
      )
    ).rejects.toThrow(/--resource/i)
  })

  it('rejects passing both --use-entra-id and --key-env', async () => {
    process.env.SECRET_ENV = 'k'
    await expect(
      CLAUDE_ACCOUNTS_HANDLERS['claude-accounts add'](
        buildCtx({
          provider: 'azure-foundry',
          resource: 'r',
          'use-entra-id': true,
          'key-env': 'SECRET_ENV'
        })
      )
    ).rejects.toThrow(/either.*--use-entra-id.*--key-env/i)
  })
})
