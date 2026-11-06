import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_HANDLERS } from './account'
import { RuntimeClient } from '../runtime-client'
import type { HandlerContext } from '../dispatch'

describe('account moves surface', () => {
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

  const moves = [
    {
      ptyId: 'pty-new',
      paneKey: 'tab-1:leaf-1',
      fromAccountId: 'acct-a',
      toAccountId: 'acct-b',
      window: 'session',
      percent: 96,
      line: 95,
      reason: 'moved',
      at: Date.parse('2026-10-29T15:04:05.000Z'),
      strategy: 'proxy'
    },
    {
      ptyId: 'pty-old',
      paneKey: null,
      fromAccountId: 'acct-b',
      toAccountId: null,
      window: null,
      percent: null,
      line: null,
      reason: 'stay',
      at: Date.parse('2026-10-29T15:00:00.000Z')
    }
  ]

  beforeEach(() => {
    callMock.mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: {
        claude: { accounts: [], activeAccountId: null, sessionMoves: moves },
        codex: { accounts: [], activeAccountId: null }
      },
      _meta: { runtimeId: 'test-runtime' }
    })
  })
  afterEach(() => logSpy.mockRestore())

  it('prints each decision newest first with pane, accounts, reason, and strategy', async () => {
    await ACCOUNT_HANDLERS['account moves'](context([]))
    expect(callMock).toHaveBeenCalledWith('accounts.list', { refreshUsage: false })
    expect(logSpy.mock.calls.map((call) => String(call[0]))).toEqual([
      '2026-10-29T15:04:05.000Z  tab-1:leaf-1  acct-a → acct-b  moved  proxy',
      '2026-10-29T15:00:00.000Z  pty-old  acct-b → -  stay  -'
    ])
  })

  it('prints the sessionMoves array with --json', async () => {
    await ACCOUNT_HANDLERS['account moves'](context([], true))
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual(moves)
  })

  it('says when the mover has no decisions', async () => {
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: {
        claude: { accounts: [], activeAccountId: null, sessionMoves: [] },
        codex: { accounts: [], activeAccountId: null }
      },
      _meta: { runtimeId: 'test-runtime' }
    })
    await ACCOUNT_HANDLERS['account moves'](context([['agent', 'claude']]))
    expect(logSpy).toHaveBeenCalledWith('No Claude session moves.')
  })

  it('rejects an agent other than claude', async () => {
    await expect(ACCOUNT_HANDLERS['account moves'](context([['agent', 'codex']]))).rejects.toThrow(
      'Only --agent claude'
    )
    expect(callMock).not.toHaveBeenCalled()
  })
})
