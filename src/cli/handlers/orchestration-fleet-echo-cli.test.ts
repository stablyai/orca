import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const getTerminalHandleMock = vi.hoisted(() => vi.fn())
const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
const originalPaneKey = process.env.ORCA_PANE_KEY

// Why: isolate the handler's flag-to-param mapping; printResult only writes output.
vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'

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

describe('orchestration fleet echo caller handle', () => {
  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PANE_KEY
  })

  const invokeDispatchShow = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration dispatch-show']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

  it('sends the caller handle on dispatch-show without --preamble, so the fleet block can attach', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    callMock.mockResolvedValue({
      result: { dispatch: { id: 'ctx_1', task_id: 'task_1', status: 'dispatched' } }
    })

    await invokeDispatchShow(new Map<string, string | boolean>([['task', 'task_1']]))

    // Why: --preamble is what used to resolve a handle here, so the plain read reached the runtime
    // with nothing to prove Run ownership with and the block was silently omitted.
    expect(callMock).toHaveBeenCalledWith('orchestration.dispatchShow', {
      task: 'task_1',
      preamble: undefined,
      from: undefined,
      callerTerminalHandle: 'term_coord',
      devMode: false
    })
  })

  it('resolves no caller handle for dispatch-show when the block is suppressed', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    callMock.mockResolvedValue({
      result: { dispatch: { id: 'ctx_1', task_id: 'task_1', status: 'dispatched' } }
    })

    await invokeDispatchShow(
      new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['no-fleet', true]
      ])
    )

    // Why: --no-fleet must not pay for a resolve whose only consumer was the block it turned off.
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).toHaveBeenCalledWith('orchestration.dispatchShow', {
      task: 'task_1',
      preamble: undefined,
      from: undefined,
      callerTerminalHandle: undefined,
      devMode: false,
      fleet: false
    })
  })
})
