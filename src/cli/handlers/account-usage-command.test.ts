import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { RuntimeClient } from '../runtime-client'
import { showAccountUsage } from './account-usage-command'

const UPDATED_AT = Date.UTC(2026, 9, 24, 12, 0)

function accountsSnapshot() {
  return {
    claude: {
      accounts: [{ id: 'a1', email: 'work@example.com' }],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    },
    codex: { accounts: [], activeAccountId: null },
    rateLimits: {
      claude: {
        provider: 'claude',
        session: {
          usedPercent: 50,
          windowMinutes: 300,
          resetsAt: UPDATED_AT + 3_600_000,
          resetDescription: null
        },
        weekly: null,
        updatedAt: UPDATED_AT,
        error: null,
        status: 'ok'
      },
      codex: null,
      gemini: null,
      opencodeGo: null,
      kimi: null,
      antigravity: null,
      minimax: null,
      grok: null,
      cursor: null,
      zcode: null,
      claudeTarget: { runtime: 'host', wslDistro: null },
      codexTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: []
    }
  }
}

function context(flags: [string, string | boolean][]) {
  const client = new RuntimeClient(join(tmpdir(), 'orca-account-usage-test'), 1000, null, null)
  const call = vi.spyOn(client, 'call').mockResolvedValue({
    id: 'test',
    ok: true,
    result: accountsSnapshot(),
    _meta: { runtimeId: 'test-runtime' }
  })
  const ctx: HandlerContext = {
    client,
    cwd: tmpdir(),
    flags: new Map(flags),
    json: true,
    rawArgs: []
  }
  return { ctx, call }
}

afterEach(() => vi.restoreAllMocks())

describe('orca account usage', () => {
  it('reads the cached snapshot unless --fresh asks the host to re-read usage', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const cached = context([])
    await showAccountUsage(cached.ctx)
    const fresh = context([['fresh', true]])
    await showAccountUsage(fresh.ctx)

    expect(cached.call).toHaveBeenCalledWith(
      'accounts.list',
      { refreshUsage: false },
      expect.anything()
    )
    expect(fresh.call).toHaveBeenCalledWith(
      'accounts.list',
      { refreshUsage: true },
      expect.anything()
    )
  })

  it('prints System default usage and an unread managed account as JSON rows', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await showAccountUsage(context([['agent', 'claude']]).ctx)

    expect(JSON.parse(String(log.mock.calls[0][0])).result.accounts).toEqual([
      {
        agent: 'claude',
        accountId: null,
        label: 'System default',
        active: true,
        status: 'ok',
        error: null,
        windows: [
          {
            name: '5h',
            usedPercent: 50,
            windowMinutes: 300,
            resetsAt: '2026-10-24T13:00:00.000Z'
          }
        ],
        updatedAt: '2026-10-24T12:00:00.000Z'
      },
      {
        agent: 'claude',
        accountId: 'a1',
        label: 'work@example.com',
        active: false,
        status: 'unavailable',
        error: 'No usage read yet; run with --fresh.',
        windows: [],
        updatedAt: null
      }
    ])
  })

  it('rejects an unknown --agent before calling the host', async () => {
    const { ctx, call } = context([['agent', 'foo']])
    await expect(showAccountUsage(ctx)).rejects.toThrow('Unsupported --agent "foo"')
    expect(call).not.toHaveBeenCalled()
  })
})
