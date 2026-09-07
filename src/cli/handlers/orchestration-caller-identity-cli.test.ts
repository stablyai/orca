/**
 * How the orchestration CLI decides WHO is speaking.
 *
 * Split out of `orchestration.test.ts`, which sat exactly on the test-file line ceiling: these two
 * suites are one subject — the coordinator and task-creator identity a command carries — and both
 * exercise the env-handle validation and pane-remint chain rather than flag-to-param mapping.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const getTerminalHandleMock = vi.hoisted(() => vi.fn())
const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
const originalPaneKey = process.env.ORCA_PANE_KEY
// Why: isolate the handler's flag-to-param mapping; printResult only writes output.
vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { RuntimeClientError } from '../runtime-client'

function staleHandleError(): RuntimeClientError {
  return new RuntimeClientError('terminal_handle_stale', 'terminal_handle_stale')
}

// Queues the stale-handle remint chain shared by coordinator commands:
// `terminal.resolveIdentity` answers not-live → resolvePane returns liveHandle → downstream RPC.
function stubStaleHandleRemint(liveHandle: string, downstream: unknown): void {
  callMock
    .mockResolvedValueOnce(notLiveIdentity())
    .mockResolvedValueOnce({ result: { terminal: { handle: liveHandle } } })
    .mockResolvedValueOnce(downstream)
}

// Queues a not-live identity followed by a resolvePane remint that fails with `error`.
function stubStaleHandleRemintFailure(error: RuntimeClientError): void {
  callMock.mockResolvedValueOnce(notLiveIdentity()).mockRejectedValueOnce(error)
}

/** What the runtime answers for a handle whose leaf check reports `terminal_handle_stale`. */
function notLiveIdentity(): { result: { identity: { live: false } } } {
  return { result: { identity: { live: false } } }
}

function liveIdentity(handle: string): { result: { identity: { handle: string; live: true } } } {
  return { result: { identity: { handle, live: true } } }
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
    getTerminalHandleMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PANE_KEY
  })

  const invokeDispatch = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration dispatch']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

  const invokeDispatchShow = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration dispatch-show']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

  const invokeRun = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration coordinator-start']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

  it('remints a stale coordinator env handle from the caller pane key', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale_coord'
    process.env.ORCA_PANE_KEY = 'tab_coord:leaf_coord'
    stubStaleHandleRemint('term_live_coord', {
      result: { dispatch: { id: 'ctx_1', task_id: 'task_1', status: 'dispatched' } }
    })
    getTerminalHandleMock.mockRejectedValue(new Error('active terminal fallback is unsafe'))

    await invokeDispatch(
      new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['to', 'term_worker'],
        ['inject', true]
      ])
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.resolveIdentity', {
      terminal: 'term_stale_coord'
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'terminal.resolvePane', {
      paneKey: 'tab_coord:leaf_coord'
    })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).toHaveBeenNthCalledWith(3, 'orchestration.dispatch', {
      task: 'task_1',
      to: 'term_worker',
      from: 'term_live_coord',
      inject: true,
      dryRun: undefined,
      returnPreamble: undefined,
      devMode: false
    })
  })

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

  it('uses a live coordinator handle for dispatch-show preamble previews', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale_coord'
    process.env.ORCA_PANE_KEY = 'tab_coord:leaf_coord'
    stubStaleHandleRemint('term_live_coord', {
      result: { dispatch: null, preamble: 'preamble' }
    })
    getTerminalHandleMock.mockRejectedValue(new Error('active terminal fallback is unsafe'))

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
      devMode: false
    })
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

  it('records a live env terminal handle as task creator', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_creator'
    callMock
      .mockResolvedValueOnce(liveIdentity('term_creator'))
      .mockResolvedValueOnce({ result: { task: { id: 'task_1', status: 'ready' } } })

    await invokeTaskCreate(new Map<string, string | boolean>([['spec', 'do work']]))

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.resolveIdentity', {
      terminal: 'term_creator'
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'orchestration.taskCreate', {
      spec: 'do work',
      taskTitle: undefined,
      displayName: undefined,
      deps: undefined,
      parent: undefined,
      run: undefined,
      callerTerminalHandle: 'term_creator'
    })
  })

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

  it('propagates runtime unavailability while proving the bound coordinator', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_creator'
    callMock.mockRejectedValueOnce(
      new RuntimeClientError('runtime_unavailable', 'runtime_unavailable')
    )

    await expect(
      invokeTaskCreate(new Map<string, string | boolean>([['spec', 'do work']]))
    ).rejects.toMatchObject({ code: 'runtime_unavailable' })

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.resolveIdentity', {
      terminal: 'term_creator'
    })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).toHaveBeenCalledTimes(1)
  })

  it('propagates runtime unavailability while reminting the bound coordinator', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale'
    process.env.ORCA_PANE_KEY = 'tab_creator:leaf_creator'
    stubStaleHandleRemintFailure(
      new RuntimeClientError('runtime_unavailable', 'runtime_unavailable')
    )
    getTerminalHandleMock.mockResolvedValue('term_wrong_active')

    await expect(
      invokeTaskCreate(new Map<string, string | boolean>([['spec', 'do work']]))
    ).rejects.toMatchObject({ code: 'runtime_unavailable' })

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.resolveIdentity', {
      terminal: 'term_stale'
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'terminal.resolvePane', {
      paneKey: 'tab_creator:leaf_creator'
    })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).toHaveBeenCalledTimes(2)
  })

  it('propagates unexpected caller pane remint failures for task creation', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale'
    process.env.ORCA_PANE_KEY = 'tab_creator:leaf_creator'
    stubStaleHandleRemintFailure(new RuntimeClientError('permission_denied', 'denied'))
    getTerminalHandleMock.mockResolvedValue('term_wrong_active')

    await expect(
      invokeTaskCreate(new Map<string, string | boolean>([['spec', 'do work']]))
    ).rejects.toMatchObject({
      code: 'permission_denied'
    })

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.resolveIdentity', {
      terminal: 'term_stale'
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'terminal.resolvePane', {
      paneKey: 'tab_creator:leaf_creator'
    })
    expect(callMock).toHaveBeenCalledTimes(2)
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
  })

  it('propagates unexpected env handle validation failures', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_creator'
    callMock.mockRejectedValueOnce(new RuntimeClientError('permission_denied', 'denied'))

    await expect(
      invokeTaskCreate(new Map<string, string | boolean>([['spec', 'do work']]))
    ).rejects.toMatchObject({
      code: 'permission_denied'
    })

    expect(callMock).toHaveBeenCalledTimes(1)
  })

  it('remints a stale task creator env handle from the caller pane key', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale'
    process.env.ORCA_PANE_KEY = 'tab_creator:leaf_creator'
    stubStaleHandleRemint('term_live', {
      result: { task: { id: 'task_1', status: 'ready' } }
    })
    getTerminalHandleMock.mockRejectedValue(new Error('active terminal fallback is unsafe'))

    await invokeTaskCreate(new Map<string, string | boolean>([['spec', 'do work']]))

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.resolveIdentity', {
      terminal: 'term_stale'
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'terminal.resolvePane', {
      paneKey: 'tab_creator:leaf_creator'
    })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).toHaveBeenNthCalledWith(3, 'orchestration.taskCreate', {
      spec: 'do work',
      taskTitle: undefined,
      displayName: undefined,
      deps: undefined,
      parent: undefined,
      run: undefined,
      callerTerminalHandle: 'term_live'
    })
  })
})
