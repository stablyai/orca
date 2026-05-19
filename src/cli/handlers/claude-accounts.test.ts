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
