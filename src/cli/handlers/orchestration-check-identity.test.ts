import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.hoisted(() => vi.fn())
const getTerminalHandleMock = vi.hoisted(() => vi.fn())
const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
const originalPaneKey = process.env.ORCA_PANE_KEY

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'

describe('orchestration check identity', () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ result: { messages: [], count: 0 } })
    getTerminalHandleMock.mockReset()
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PANE_KEY
  })

  afterEach(() => {
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

  const invokeCheck = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration check']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

  it('carries the caller pane key when the environment handle may be stale', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale_coord'
    process.env.ORCA_PANE_KEY = 'tab_coord:leaf_coord'
    getTerminalHandleMock.mockRejectedValue(new Error('active terminal fallback is unsafe'))

    await invokeCheck(new Map<string, string | boolean>([['wait', true]]))

    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).toHaveBeenCalledWith(
      'orchestration.check',
      expect.objectContaining({
        terminal: 'term_stale_coord',
        terminalPaneKey: 'tab_coord:leaf_coord',
        wait: true
      })
    )
  })

  it('keeps an explicit legacy terminal handle scoped to that handle', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale_env'

    await invokeCheck(new Map<string, string | boolean>([['terminal', 'term_legacy_worker']]))

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith(
      'orchestration.check',
      expect.objectContaining({
        terminal: 'term_legacy_worker',
        terminalPaneKey: undefined
      })
    )
  })

  it('preserves the pinned legacy --inject check signature', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_legacy_worker'

    await invokeCheck(
      new Map<string, string | boolean>([
        ['unread', true],
        ['inject', true]
      ])
    )

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.check',
      expect.objectContaining({
        terminal: 'term_legacy_worker',
        unread: true,
        inject: true
      })
    )
  })
})
