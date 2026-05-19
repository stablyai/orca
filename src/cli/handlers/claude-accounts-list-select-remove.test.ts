import { describe, expect, it, vi, beforeEach } from 'vitest'
import { CLAUDE_ACCOUNTS_HANDLERS } from './claude-accounts'

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

describe('claude-accounts list/select/remove', () => {
  it('list prints accounts as JSON array', async () => {
    callMock.mockResolvedValueOnce({
      result: { accounts: [{ id: 'a', email: 'a@b' }] }
    })
    await CLAUDE_ACCOUNTS_HANDLERS['claude-accounts list'](buildCtx({}))
    expect(callMock).toHaveBeenCalledWith('claudeAccounts.list', {})
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ ok: true, accounts: [{ id: 'a', email: 'a@b' }] })
    )
  })

  it('select passes account-id to RPC', async () => {
    callMock.mockResolvedValueOnce({ result: { activeAccountId: 'a' } })
    await CLAUDE_ACCOUNTS_HANDLERS['claude-accounts select'](buildCtx({ 'account-id': 'a' }))
    expect(callMock).toHaveBeenCalledWith('claudeAccounts.select', { accountId: 'a' })
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ ok: true, activeAccountId: 'a' }))
  })

  it('remove passes account-id', async () => {
    callMock.mockResolvedValueOnce({ result: { removed: true } })
    await CLAUDE_ACCOUNTS_HANDLERS['claude-accounts remove'](buildCtx({ 'account-id': 'a' }))
    expect(callMock).toHaveBeenCalledWith('claudeAccounts.remove', { accountId: 'a' })
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ ok: true, removed: true }))
  })

  it('add --validate triggers post-add validate probe', async () => {
    process.env.SECRET_ENV = 'sk'
    callMock
      .mockResolvedValueOnce({
        result: { accountId: 'a', email: 'Work', accounts: [], activeAccountId: 'a' }
      })
      .mockResolvedValueOnce({ result: { ok: true } })
    await CLAUDE_ACCOUNTS_HANDLERS['claude-accounts add'](
      buildCtx({
        provider: 'anthropic-api-key',
        label: 'Work',
        'key-env': 'SECRET_ENV',
        validate: true
      })
    )
    expect(callMock).toHaveBeenNthCalledWith(2, 'claudeAccounts.validate', { accountId: 'a' })
  })

  it('add --validate failure emits ok:false and non-zero exit', async () => {
    process.env.SECRET_ENV = 'sk'
    callMock
      .mockResolvedValueOnce({
        result: { accountId: 'a', email: 'Work', accounts: [], activeAccountId: 'a' }
      })
      .mockResolvedValueOnce({ result: { ok: false, error: 'invalid key' } })
    await expect(
      CLAUDE_ACCOUNTS_HANDLERS['claude-accounts add'](
        buildCtx({
          provider: 'anthropic-api-key',
          label: 'Work',
          'key-env': 'SECRET_ENV',
          validate: true
        })
      )
    ).rejects.toThrow(/invalid key/)
    expect(process.exitCode).toBe(1)
  })
})
