import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.hoisted(() => vi.fn())
const getTerminalHandleMock = vi.hoisted(() => vi.fn())
const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE

// Why: isolate flag-to-RPC mapping; printResult only writes output.
vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'

describe('orchestration task-create CLI mapping', () => {
  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    process.env.ORCA_TERMINAL_HANDLE = 'term_creator'
  })

  afterEach(() => {
    if (originalTerminalHandle === undefined) {
      delete process.env.ORCA_TERMINAL_HANDLE
    } else {
      process.env.ORCA_TERMINAL_HANDLE = originalTerminalHandle
    }
  })

  it('passes PowerShell-stripped deps through to the runtime', async () => {
    callMock
      .mockResolvedValueOnce({ result: { terminal: { handle: 'term_creator' } } })
      .mockResolvedValueOnce({ result: { task: { id: 'task_2', status: 'pending' } } })

    await ORCHESTRATION_HANDLERS['orchestration task-create']({
      flags: new Map<string, string | boolean>([
        ['spec', 'do child work'],
        ['deps', '[task_b2a580db74d8]']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(callMock).toHaveBeenNthCalledWith(2, 'orchestration.taskCreate', {
      spec: 'do child work',
      taskTitle: undefined,
      displayName: undefined,
      deps: '[task_b2a580db74d8]',
      parent: undefined,
      run: undefined,
      callerTerminalHandle: 'term_creator'
    })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
  })
})
