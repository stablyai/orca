import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_HANDLERS } from './account'
import { RuntimeClient } from '../runtime-client'
import type { HandlerContext } from '../dispatch'

describe('account pool surface', () => {
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

  it('sets the pool through accounts.setClaudeAccountPool and prints it', async () => {
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: { accounts: [], activeAccountId: null, pool: 'on' },
      _meta: { runtimeId: 'test-runtime' }
    })
    await ACCOUNT_HANDLERS['account pool'](
      context([
        ['agent', 'claude'],
        ['on', true]
      ])
    )
    expect(callMock).toHaveBeenCalledWith('accounts.setClaudeAccountPool', { enabled: true })
    expect(logSpy).toHaveBeenCalledWith('Claude account pool: on')
  })

  it('prints JSON with --json', async () => {
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: { accounts: [], activeAccountId: null, pool: 'off' },
      _meta: { runtimeId: 'test-runtime' }
    })
    await ACCOUNT_HANDLERS['account pool'](context([['off', true]], true))
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual({ pool: 'off' })
  })

  it('needs exactly one of --on or --off and only --agent claude', async () => {
    await expect(ACCOUNT_HANDLERS['account pool'](context([]))).rejects.toThrow(
      'exactly one of --on or --off'
    )
    await expect(
      ACCOUNT_HANDLERS['account pool'](
        context([
          ['on', true],
          ['off', true]
        ])
      )
    ).rejects.toThrow('exactly one of --on or --off')
    await expect(
      ACCOUNT_HANDLERS['account pool'](
        context([
          ['agent', 'codex'],
          ['on', true]
        ])
      )
    ).rejects.toThrow('Only --agent claude')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('shows pool and per-account session counts when the host reports them', async () => {
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: {
        claude: {
          accounts: [
            { id: 'a', email: 'a@example.com' },
            { id: 'b', email: 'b@example.com' }
          ],
          activeAccountId: 'a',
          autoSwitchEnabled: true,
          sessionMover: 'move',
          pool: 'on',
          assignedSessions: [
            { accountId: 'a', count: 2 },
            { accountId: 'b', count: 0 }
          ]
        },
        codex: { accounts: [], activeAccountId: null }
      },
      _meta: { runtimeId: 'test-runtime' }
    })
    await ACCOUNT_HANDLERS['account list']({ ...context([]), flags: new Map() })
    const printed = String(logSpy.mock.calls[0]?.[0])
    expect(printed).toContain('  auto-switch: on\n  session-mover: move\n  pool: on')
    expect(printed).toContain('  a@example.com (active)  sessions: 2')
    expect(printed).toContain('  b@example.com  sessions: 0')
  })
})
