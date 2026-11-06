import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_HANDLERS } from './account'
import { RuntimeClient } from '../runtime-client'
import type { HandlerContext } from '../dispatch'

describe('account token-refresh', () => {
  const client = new RuntimeClient()
  const callMock = vi.spyOn(client, 'call')
  let logSpy: ReturnType<typeof vi.spyOn>

  function context(flags: [string, string | boolean][], json = false): HandlerContext {
    return {
      client,
      cwd: process.cwd(),
      flags: new Map<string, string | boolean>(flags),
      json,
      rawArgs: []
    }
  }

  beforeEach(() => {
    callMock.mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => logSpy.mockRestore())

  it('refreshes one account now and prints ok without a token', async () => {
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: { accountId: 'acct-1', email: 'ada@example', outcome: 'ok', accessToken: 'nope' },
      _meta: { runtimeId: 'test-runtime' }
    })
    await ACCOUNT_HANDLERS['account token-refresh'](
      context([
        ['agent', 'claude'],
        ['now', 'ada@example'],
        ['force', true]
      ])
    )
    expect(callMock).toHaveBeenCalledWith('accounts.refreshClaudeAccountTokenNow', {
      account: 'ada@example',
      force: true
    })
    expect(logSpy).toHaveBeenCalledWith('refresh ada@example ok')
    expect(String(logSpy.mock.calls.flat().join(' '))).not.toContain('nope')
  })

  it('prints the queue position and backoff level', async () => {
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: {
        claude: {
          accounts: [],
          activeAccountId: null,
          tokenRefresh: 'on',
          tokenRefreshAccounts: [
            {
              accountId: 'acct-1',
              lastRefreshAt: null,
              nextRetryAt: 1,
              lapsed: false,
              queuePosition: 2,
              backoffLevel: 1
            }
          ]
        }
      },
      _meta: { runtimeId: 'test-runtime' }
    })
    await ACCOUNT_HANDLERS['account token-refresh'](
      context([
        ['agent', 'claude'],
        ['status', true]
      ])
    )
    const text = String(logSpy.mock.calls[0]?.[0])
    expect(text).toContain('queued #2')
    expect(text).toContain('backoff 1')
  })

  it('requires one mode and a value for --now', async () => {
    await expect(
      ACCOUNT_HANDLERS['account token-refresh'](context([['agent', 'claude']]))
    ).rejects.toThrow('exactly one of --on, --off, --status, or --now')
    await expect(
      ACCOUNT_HANDLERS['account token-refresh'](
        context([
          ['agent', 'claude'],
          ['now', true]
        ])
      )
    ).rejects.toThrow('Pass --now <email|id>.')
    await expect(
      ACCOUNT_HANDLERS['account token-refresh'](
        context([
          ['agent', 'claude'],
          ['force', true]
        ])
      )
    ).rejects.toThrow('Pass --force only with --now')
    expect(callMock).not.toHaveBeenCalled()
  })
})
