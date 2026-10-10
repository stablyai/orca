/**
 * A structured chat session with NO orchestration identity must refuse, not guess.
 *
 * Non-worker structured sessions get no `ORCA_TERMINAL_HANDLE`, so `orchestration check` fell
 * through to the active-terminal guess — and `check` is destructive by default, so it consumed
 * another pane's oldest unread batch and marked it read. The rightful worker never saw that mail.
 *
 * The case pinned here is ONE terminal pane in the worktree, because that is the case
 * `requireUnambiguous` misses: with a single candidate the guess still resolves, to a sibling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_STRUCTURED_SESSION_ENV } from '../shared/structured-session-marker'

const callMock = vi.hoisted(() => vi.fn())
const getTerminalHandleMock = vi.hoisted(() => vi.fn())

vi.mock('./format', () => ({ printResult: vi.fn() }))
vi.mock('./selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './handlers/orchestration'

const originalMarker = process.env[ORCA_STRUCTURED_SESSION_ENV]
const originalHandle = process.env.ORCA_TERMINAL_HANDLE

function invoke(command: string, flags = new Map<string, string | boolean>()) {
  return ORCHESTRATION_HANDLERS[command]!({
    flags,
    client: { call: callMock },
    cwd: '/tmp/repo',
    json: true
  } as never)
}

describe('a structured chat session with no orchestration identity', () => {
  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
    process.env[ORCA_STRUCTURED_SESSION_ENV] = '1'
    // Exactly ONE terminal pane in the worktree: the single-candidate case, where
    // `requireUnambiguous` still resolves and would hand this session a sibling's handle.
    getTerminalHandleMock.mockResolvedValue('term_sibling')
  })

  afterEach(() => {
    if (originalMarker === undefined) {
      delete process.env[ORCA_STRUCTURED_SESSION_ENV]
    } else {
      process.env[ORCA_STRUCTURED_SESSION_ENV] = originalMarker
    }
    if (originalHandle === undefined) {
      delete process.env.ORCA_TERMINAL_HANDLE
    } else {
      process.env.ORCA_TERMINAL_HANDLE = originalHandle
    }
  })

  it('refuses a bare check instead of consuming the mailbox of a sibling pane', async () => {
    await expect(invoke('orchestration check')).rejects.toMatchObject({
      code: 'no_active_sender_terminal',
      message: expect.stringContaining('--terminal')
    })
    // Neither guessed nor sent: a destructive read must not reach the runtime at all.
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).not.toHaveBeenCalled()
  })

  it('refuses a bare send for the same reason, naming --from', async () => {
    await expect(
      invoke(
        'orchestration send',
        new Map<string, string | boolean>([
          ['to', 'term_coord'],
          ['subject', 'hi'],
          ['body', 'hello']
        ])
      )
    ).rejects.toMatchObject({ message: expect.stringContaining('--from') })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('still accepts an explicit --terminal, which is the actionable escape', async () => {
    callMock.mockResolvedValue({ result: { messages: [], count: 0 } })
    await invoke('orchestration check', new Map([['terminal', 'structworker_self']]))
    expect(callMock).toHaveBeenCalledWith(
      'orchestration.check',
      expect.objectContaining({ terminal: 'structworker_self' })
    )
  })

  it('leaves an ordinary shell alone, which has no marker and may still guess', async () => {
    delete process.env[ORCA_STRUCTURED_SESSION_ENV]
    callMock.mockResolvedValue({ result: { messages: [], count: 0 } })
    await invoke('orchestration check')
    expect(getTerminalHandleMock).toHaveBeenCalled()
  })
})
