import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const getTerminalHandleMock = vi.hoisted(() => vi.fn())
const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
const originalPaneKey = process.env.ORCA_PANE_KEY

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { RuntimeClientError } from '../runtime-client'

function invokeDispatchShow(flags: Map<string, string | boolean>) {
  return ORCHESTRATION_HANDLERS['orchestration dispatch-show']({
    flags,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test harness mocks RuntimeClient with call mock
    client: { call: callMock } as never,
    cwd: process.cwd(),
    json: true
  })
}

function restoreEnv(name: 'ORCA_TERMINAL_HANDLE' | 'ORCA_PANE_KEY', value: string | undefined) {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

describe('orchestration dispatch-show caller scope', () => {
  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PANE_KEY
  })

  afterEach(() => {
    restoreEnv('ORCA_TERMINAL_HANDLE', originalTerminalHandle)
    restoreEnv('ORCA_PANE_KEY', originalPaneKey)
  })

  it('remints a live caller for preamble previews', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale_coord'
    process.env.ORCA_PANE_KEY = 'tab_coord:leaf_coord'
    callMock
      .mockRejectedValueOnce(
        new RuntimeClientError('terminal_handle_stale', 'terminal_handle_stale')
      )
      .mockResolvedValueOnce({ result: { terminal: { handle: 'term_live_coord' } } })
      .mockResolvedValueOnce({ result: { dispatch: null, preamble: 'preamble' } })

    await invokeDispatchShow(
      new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['preamble', true]
      ])
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.resolveIdentity', {
      terminal: 'term_stale_coord'
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'terminal.resolvePane', {
      paneKey: 'tab_coord:leaf_coord'
    })
    expect(callMock).toHaveBeenNthCalledWith(3, 'orchestration.dispatchShow', {
      task: 'task_1',
      preamble: true,
      from: 'term_live_coord',
      callerTerminalHandle: 'term_live_coord',
      devMode: false
    })
  })

  it('scopes reads when no preamble is requested', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    callMock
      .mockResolvedValueOnce({ result: { identity: { live: true } } })
      .mockResolvedValueOnce({ result: { dispatch: null } })

    await invokeDispatchShow(new Map<string, string | boolean>([['task', 'task_1']]))

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.resolveIdentity', {
      terminal: 'term_coord'
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'orchestration.dispatchShow', {
      task: 'task_1',
      preamble: undefined,
      from: undefined,
      callerTerminalHandle: 'term_coord',
      devMode: false
    })
  })
})
