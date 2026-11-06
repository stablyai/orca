import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_HANDLERS } from './account'
import { RuntimeClient } from '../runtime-client'
import type { HandlerContext } from '../dispatch'

describe('account session-mover surface', () => {
  const client = new RuntimeClient()
  const callMock = vi.spyOn(client, 'call')
  let logSpy: ReturnType<typeof vi.spyOn>

  function context(agent: string, json = false): HandlerContext {
    return { client, cwd: process.cwd(), flags: new Map([['agent', agent]]), json, rawArgs: [] }
  }

  beforeEach(() => {
    callMock.mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => logSpy.mockRestore())

  describe('account session-mover', () => {
    function moverContext(flags: [string, string | boolean][], json = false): HandlerContext {
      return { ...context('claude', json), flags: new Map<string, string | boolean>(flags) }
    }

    it('sets the policy through accounts.setClaudeSessionMover and prints it', async () => {
      callMock.mockResolvedValue({
        id: 'test',
        ok: true,
        result: { accounts: [], activeAccountId: null, sessionMover: 'move' },
        _meta: { runtimeId: 'test-runtime' }
      })
      await ACCOUNT_HANDLERS['account session-mover'](
        moverContext([
          ['agent', 'claude'],
          ['move', true]
        ])
      )
      expect(callMock).toHaveBeenCalledWith('accounts.setClaudeSessionMover', { setting: 'move' })
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('session-mover: move'))
    })

    it('prints JSON with --json', async () => {
      callMock.mockResolvedValue({
        id: 'test',
        ok: true,
        result: { accounts: [], activeAccountId: null, sessionMover: 'off' },
        _meta: { runtimeId: 'test-runtime' }
      })
      await ACCOUNT_HANDLERS['account session-mover'](moverContext([['off', true]], true))
      expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual({ sessionMover: 'off' })
    })

    it('needs exactly one of --off, --ask, --move and only --agent claude', async () => {
      await expect(ACCOUNT_HANDLERS['account session-mover'](moverContext([]))).rejects.toThrow(
        'exactly one of --off, --ask or --move'
      )
      await expect(
        ACCOUNT_HANDLERS['account session-mover'](
          moverContext([
            ['ask', true],
            ['move', true]
          ])
        )
      ).rejects.toThrow('exactly one of --off, --ask or --move')
      await expect(
        ACCOUNT_HANDLERS['account session-mover'](
          moverContext([
            ['agent', 'codex'],
            ['move', true]
          ])
        )
      ).rejects.toThrow('Only --agent claude')
      expect(callMock).not.toHaveBeenCalled()
    })
  })

  it('shows the session-mover policy in the Claude block when the host reports it', async () => {
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: {
        claude: {
          accounts: [{ id: 'a', email: 'a@example.com' }],
          activeAccountId: 'a',
          autoSwitchEnabled: true,
          sessionMover: 'move'
        },
        codex: { accounts: [], activeAccountId: null }
      },
      _meta: { runtimeId: 'test-runtime' }
    })
    await ACCOUNT_HANDLERS['account list']({ ...context('claude'), flags: new Map() })
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('  auto-switch: on\n  session-mover: move')
    )
  })

  it('prints each live session decision, including a background-work wait', async () => {
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: {
        claude: {
          accounts: [{ id: 'a', email: 'a@example.com' }],
          activeAccountId: 'a',
          sessionMover: 'move',
          sessionMoves: [
            {
              ptyId: 'pty-1',
              paneKey: 'pane-1',
              fromAccountId: 'a',
              toAccountId: null,
              window: 'session',
              percent: 96,
              line: 95,
              reason: 'wait:background-work',
              at: 123
            }
          ]
        },
        codex: { accounts: [], activeAccountId: null }
      },
      _meta: { runtimeId: 'test-runtime' }
    })
    await ACCOUNT_HANDLERS['account list']({ ...context('claude'), flags: new Map() })
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('  session pty-1: wait:background-work')
    )
  })

  it('preserves the host session-mover policy and live decisions in account list JSON', async () => {
    const snapshot = {
      claude: {
        accounts: [],
        activeAccountId: null,
        sessionMover: 'ask',
        sessionMoves: [
          {
            ptyId: 'pty-1',
            paneKey: 'pane-1',
            fromAccountId: 'a',
            toAccountId: 'b',
            window: 'session',
            percent: 96,
            line: 95,
            reason: 'moved',
            at: 123
          }
        ]
      },
      codex: { accounts: [], activeAccountId: null }
    }
    callMock.mockResolvedValue({
      id: 'test',
      ok: true,
      result: snapshot,
      _meta: { runtimeId: 'test-runtime' }
    })
    await ACCOUNT_HANDLERS['account list']({ ...context('claude', true), flags: new Map() })
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0])).result).toEqual(snapshot)
  })
})
