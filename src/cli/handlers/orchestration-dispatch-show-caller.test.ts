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

describe('orchestration dispatch-show caller identity', () => {
  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    // Why: the focus-based selector must never run for a read; any call is the bug under test.
    getTerminalHandleMock.mockRejectedValue(new Error('focus-based selection must not run'))
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PANE_KEY
  })

  const invokeDispatchShow = (
    flags: Map<string, string | boolean>,
    cwd = '/tmp/repo'
  ): Promise<void> =>
    ORCHESTRATION_HANDLERS['orchestration dispatch-show']({
      flags,
      client: { call: callMock },
      cwd,
      json: true
    } as never)

  const showFlags = (): Map<string, string | boolean> =>
    new Map<string, string | boolean>([['task', 'task_1']])

  it('sends a live env handle as the caller identity', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    callMock
      .mockResolvedValueOnce({ result: { terminal: { handle: 'term_coord' } } })
      .mockResolvedValueOnce({ result: { dispatch: null } })

    await invokeDispatchShow(showFlags())

    expect(callMock).toHaveBeenNthCalledWith(2, 'orchestration.dispatchShow', {
      task: 'task_1',
      preamble: undefined,
      from: undefined,
      callerTerminalHandle: 'term_coord',
      devMode: false
    })
  })

  it('omits the caller handle when no identity resolves and still returns the read', async () => {
    callMock.mockResolvedValueOnce({ result: { dispatch: { id: 'ctx_1' } } })

    await invokeDispatchShow(showFlags())

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenNthCalledWith(1, 'orchestration.dispatchShow', {
      task: 'task_1',
      preamble: undefined,
      from: undefined,
      callerTerminalHandle: undefined,
      devMode: false
    })
  })

  // Why: a headless or remote caller has no focused pane; attributing the read to whichever
  // terminal happens to be focused would name a terminal the caller does not own.
  it('never falls back to the focus-selected active terminal', async () => {
    callMock.mockResolvedValueOnce({ result: { dispatch: null } })

    await invokeDispatchShow(showFlags())

    expect(getTerminalHandleMock).not.toHaveBeenCalled()
  })

  it('omits the caller handle instead of failing when identity resolution errors', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    process.env.ORCA_PANE_KEY = 'tab_coord:leaf_coord'
    callMock
      .mockRejectedValueOnce(new RuntimeClientError('runtime_unavailable', 'runtime_unavailable'))
      .mockResolvedValueOnce({ result: { dispatch: null } })

    await invokeDispatchShow(showFlags())

    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'orchestration.dispatchShow',
      expect.objectContaining({ task: 'task_1', callerTerminalHandle: undefined })
    )
  })

  // Why: an SSH/remote pane names itself through ORCA_PANE_KEY when its env handle was reminted
  // host-side; that remint is the only remote-safe way to recover identity.
  it('remints a stale remote pane handle from ORCA_PANE_KEY', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale_remote'
    process.env.ORCA_PANE_KEY = 'tab_remote:leaf_remote'
    callMock
      .mockRejectedValueOnce(staleHandleError())
      .mockResolvedValueOnce({ result: { terminal: { handle: 'term_live_remote' } } })
      .mockResolvedValueOnce({ result: { dispatch: null } })

    await invokeDispatchShow(showFlags())

    expect(callMock).toHaveBeenNthCalledWith(2, 'terminal.resolvePane', {
      paneKey: 'tab_remote:leaf_remote'
    })
    expect(callMock).toHaveBeenNthCalledWith(3, 'orchestration.dispatchShow', {
      task: 'task_1',
      preamble: undefined,
      from: undefined,
      callerTerminalHandle: 'term_live_remote',
      devMode: false
    })
  })

  it('omits the caller handle when a remote pane can no longer be reminted', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale_remote'
    process.env.ORCA_PANE_KEY = 'tab_remote:leaf_remote'
    callMock
      .mockRejectedValueOnce(staleHandleError())
      .mockRejectedValueOnce(new RuntimeClientError('terminal_gone', 'terminal_gone'))
      .mockResolvedValueOnce({ result: { dispatch: null } })

    await invokeDispatchShow(showFlags())

    expect(callMock).toHaveBeenNthCalledWith(
      3,
      'orchestration.dispatchShow',
      expect.objectContaining({ callerTerminalHandle: undefined })
    )
  })

  // Why: not every workspace is a git worktree; a folder context resolves identity the same way
  // and must not reach for any repo-shaped lookup.
  it('resolves identity the same way from a folder workspace', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_folder'
    callMock
      .mockResolvedValueOnce({ result: { terminal: { handle: 'term_folder' } } })
      .mockResolvedValueOnce({ result: { dispatch: null } })

    await invokeDispatchShow(showFlags(), '/tmp/plain-folder')

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.show', { terminal: 'term_folder' })
    expect(callMock).toHaveBeenNthCalledWith(2, 'orchestration.dispatchShow', {
      task: 'task_1',
      preamble: undefined,
      from: undefined,
      callerTerminalHandle: 'term_folder',
      devMode: false
    })
    expect(callMock).toHaveBeenCalledTimes(2)
  })

  // Why: --from is how an SSH or detached shell names itself when no live pane env is present.
  it('honours an explicit --from without probing for a terminal', async () => {
    callMock.mockResolvedValueOnce({ result: { dispatch: null } })

    await invokeDispatchShow(
      new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['from', 'term_explicit']
      ])
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenNthCalledWith(1, 'orchestration.dispatchShow', {
      task: 'task_1',
      preamble: undefined,
      from: undefined,
      callerTerminalHandle: 'term_explicit',
      devMode: false
    })
  })

  // Why: --preamble keeps main's strict resolution because the handle is embedded in the preview text.
  it('uses a live coordinator handle for preamble previews', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale_coord'
    process.env.ORCA_PANE_KEY = 'tab_coord:leaf_coord'
    callMock
      .mockRejectedValueOnce(staleHandleError())
      .mockResolvedValueOnce({ result: { terminal: { handle: 'term_live_coord' } } })
      .mockResolvedValueOnce({ result: { dispatch: null, preamble: 'preamble' } })

    await invokeDispatchShow(
      new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['preamble', true]
      ])
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.show', {
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
})
