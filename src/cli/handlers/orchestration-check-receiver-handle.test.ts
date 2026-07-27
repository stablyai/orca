import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const getTerminalHandleMock = vi.hoisted(() => vi.fn())
const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
const originalPaneKey = process.env.ORCA_PANE_KEY

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { RuntimeClientError } from '../runtime-client'

function staleHandleError(): RuntimeClientError {
  return new RuntimeClientError('terminal_handle_stale', 'terminal_handle_stale')
}

// Queues the stale-handle remint chain: stale terminal.show → resolvePane returns
// liveHandle → downstream orchestration.check result.
function stubStaleHandleRemint(liveHandle: string, downstream: unknown): void {
  callMock
    .mockRejectedValueOnce(staleHandleError())
    .mockResolvedValueOnce({ result: { terminal: { handle: liveHandle } } })
    .mockResolvedValueOnce(downstream)
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

// Why: `check` resolves its implicit identity via validateEnvHandle, so a stale
// ORCA_TERMINAL_HANDLE left by an app restart is reminted instead of listening on
// a dead mailbox. Mirrors the dispatch coordinator-handle remint coverage.
describe('orchestration check receiver handle', () => {
  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PANE_KEY
  })

  const invokeCheck = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration check']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

  it('remints a stale receiver env handle from the caller pane key', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale_worker'
    process.env.ORCA_PANE_KEY = 'tab_worker:leaf_worker'
    stubStaleHandleRemint('term_live_worker', { result: { messages: [], count: 0 } })
    getTerminalHandleMock.mockRejectedValue(new Error('active terminal fallback is unsafe'))

    await invokeCheck(new Map())

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.show', {
      terminal: 'term_stale_worker'
    })
    expect(callMock).toHaveBeenNthCalledWith(2, 'terminal.resolvePane', {
      paneKey: 'tab_worker:leaf_worker'
    })
    // Why: the reminted live handle — not the dead env handle — is the mailbox check listens on.
    expect(callMock).toHaveBeenNthCalledWith(3, 'orchestration.check', {
      terminal: 'term_live_worker',
      unread: undefined,
      peek: undefined,
      all: undefined,
      types: undefined,
      inject: undefined,
      wait: undefined,
      timeoutMs: undefined
    })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
  })

  it('uses a live receiver env handle as-is without reminting', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    process.env.ORCA_PANE_KEY = 'tab_worker:leaf_worker'
    callMock
      .mockResolvedValueOnce({ result: { terminal: { handle: 'term_worker' } } })
      .mockResolvedValueOnce({ result: { messages: [], count: 0 } })

    await invokeCheck(new Map())

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.show', { terminal: 'term_worker' })
    expect(callMock).not.toHaveBeenCalledWith('terminal.resolvePane', expect.anything())
    expect(callMock).toHaveBeenNthCalledWith(2, 'orchestration.check', {
      terminal: 'term_worker',
      unread: undefined,
      peek: undefined,
      all: undefined,
      types: undefined,
      inject: undefined,
      wait: undefined,
      timeoutMs: undefined
    })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
  })

  it('lets an explicit --terminal flag win without probing the env handle', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale_worker'
    process.env.ORCA_PANE_KEY = 'tab_worker:leaf_worker'
    callMock.mockResolvedValue({ result: { messages: [], count: 0 } })

    await invokeCheck(new Map<string, string | boolean>([['terminal', 'term_explicit']]))

    expect(callMock).not.toHaveBeenCalledWith('terminal.show', expect.anything())
    expect(callMock).not.toHaveBeenCalledWith('terminal.resolvePane', expect.anything())
    expect(callMock).toHaveBeenNthCalledWith(1, 'orchestration.check', {
      terminal: 'term_explicit',
      unread: undefined,
      peek: undefined,
      all: undefined,
      types: undefined,
      inject: undefined,
      wait: undefined,
      timeoutMs: undefined
    })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
  })

  it('falls through to active-terminal resolution when the stale receiver pane cannot remint', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale_worker'
    // No ORCA_PANE_KEY: pane remint is unavailable, so the receiver path degrades to
    // the active-terminal selector rather than throwing the sender-only error.
    callMock
      .mockRejectedValueOnce(staleHandleError())
      .mockResolvedValueOnce({ result: { messages: [], count: 0 } })
    getTerminalHandleMock.mockResolvedValue('term_active_worker')

    await invokeCheck(new Map())

    expect(callMock).toHaveBeenNthCalledWith(1, 'terminal.show', {
      terminal: 'term_stale_worker'
    })
    expect(getTerminalHandleMock).toHaveBeenCalled()
    expect(callMock).toHaveBeenNthCalledWith(2, 'orchestration.check', {
      terminal: 'term_active_worker',
      unread: undefined,
      peek: undefined,
      all: undefined,
      types: undefined,
      inject: undefined,
      wait: undefined,
      timeoutMs: undefined
    })
  })
})
