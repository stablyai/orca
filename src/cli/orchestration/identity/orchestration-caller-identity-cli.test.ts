import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const getTerminalHandleMock = vi.hoisted(() => vi.fn())
const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
const originalPaneKey = process.env.ORCA_PANE_KEY
vi.mock('../../output/command-result-output', () => ({ printResult: vi.fn() }))
vi.mock('../../terminals/terminal-selector', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from '../orchestration-handlers'
import { RuntimeClientError } from '../../runtime/connection/types'
import { printResult } from '../../output/command-result-output'

function staleHandleError(): RuntimeClientError {
  return new RuntimeClientError('terminal_handle_stale', 'terminal_handle_stale')
}

afterEach(() => {
  getTerminalHandleMock.mockReset()
  if (originalTerminalHandle === undefined) {
    delete process.env.ORCA_TERMINAL_HANDLE
  } else {
    process.env.ORCA_TERMINAL_HANDLE = originalTerminalHandle
  }
  if (originalPaneKey === undefined) {
    delete process.env.ORCA_PANE_KEY
  } else {
    process.env.ORCA_PANE_KEY = originalPaneKey
  }
})

describe('orchestration dispatch coordinator handle', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockReset()
    getTerminalHandleMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PANE_KEY
  })

  const invokeDispatch = (flags: Map<string, string | boolean>, json = true) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This handler uses only client.call, supplied by the fixture; no RuntimeClient lifecycle methods are accessed.
    ORCHESTRATION_HANDLERS['orchestration dispatch']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json
    } as never)

  it('rejects stale coordinator env handles when the caller pane cannot be proven', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale_coord'
    callMock.mockRejectedValueOnce(staleHandleError())
    getTerminalHandleMock.mockResolvedValue('term_wrong_active')

    await expect(
      invokeDispatch(
        new Map<string, string | boolean>([
          ['task', 'task_1'],
          ['to', 'term_worker']
        ])
      )
    ).rejects.toMatchObject({
      code: 'no_active_sender_terminal'
    })

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
  })
})
