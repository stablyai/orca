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
    // Even one candidate can belong to a sibling, so requireUnambiguous cannot protect this session.
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
