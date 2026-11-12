import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const getTerminalHandleMock = vi.hoisted(() => vi.fn())
const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
const originalPaneKey = process.env.ORCA_PANE_KEY
vi.mock('../command-result-output', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { RuntimeClientError } from '../runtime-client'
import { printResult } from '../command-result-output'

function staleHandleError(): RuntimeClientError {
  return new RuntimeClientError('terminal_handle_stale', 'terminal_handle_stale')
}

function stubStaleHandleRemintFailure(error: RuntimeClientError): void {
  callMock.mockResolvedValueOnce(notLiveIdentity()).mockRejectedValueOnce(error)
}

function notLiveIdentity(): { result: { identity: { live: false } } } {
  return { result: { identity: { live: false } } }
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

  const invokeRun = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration coordinator-start']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
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

  it('propagates unexpected caller pane remint failures for coordinator commands', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale_coord'
    process.env.ORCA_PANE_KEY = 'tab_coord:leaf_coord'
    stubStaleHandleRemintFailure(
      new RuntimeClientError('runtime_unavailable', 'runtime_unavailable')
    )
    getTerminalHandleMock.mockResolvedValue('term_wrong_active')

    await expect(
      invokeDispatch(
        new Map<string, string | boolean>([
          ['task', 'task_1'],
          ['to', 'term_worker']
        ])
      )
    ).rejects.toMatchObject({
      code: 'runtime_unavailable'
    })

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.resolveIdentity', {
      terminal: 'term_stale_coord'
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'terminal.resolvePane', {
      paneKey: 'tab_coord:leaf_coord'
    })
    expect(callMock).toHaveBeenCalledTimes(2)
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
  })

  it('retires the legacy coordinator command without runtime effects', async () => {
    await expect(
      invokeRun(new Map<string, string | boolean>([['spec', 'run the plan']]))
    ).rejects.toMatchObject({
      code: 'orchestration_migration_required',
      data: {
        reason: 'command_retired',
        effectsApplied: false,
        nextCommandArgs: ['skills', 'get', 'orchestration', '--full']
      }
    })
    expect(callMock).not.toHaveBeenCalled()
  })
})

describe('orchestration task-create caller handle', () => {
  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PANE_KEY
  })

  const invokeTaskCreate = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration task-create']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

  it('fails closed when a stale task creator handle cannot be reminted', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale'
    callMock.mockRejectedValueOnce(staleHandleError())
    getTerminalHandleMock.mockResolvedValue('term_wrong_active')

    await expect(
      invokeTaskCreate(new Map<string, string | boolean>([['spec', 'do work']]))
    ).rejects.toMatchObject({ code: 'no_active_sender_terminal' })

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.resolveIdentity', {
      terminal: 'term_stale'
    })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).toHaveBeenCalledTimes(1)
  })
})
