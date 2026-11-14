import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.hoisted(() => vi.fn())
const getTerminalHandleMock = vi.hoisted(() => vi.fn())
const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
const originalPaneKey = process.env.ORCA_PANE_KEY

const printResultMock = vi.hoisted(() => vi.fn())
vi.mock('../../output/command-result-output', () => ({ printResult: printResultMock }))
vi.mock('../../terminals/terminal-selector', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from '../orchestration-handlers'

describe('orchestration check identity', () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ result: { messages: [], count: 0 } })
    printResultMock.mockReset()
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

  const invokeCheck = (flags: Map<string, string | boolean>, json = true) =>
    ORCHESTRATION_HANDLERS['orchestration check']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json
    } as never)

  it('rejects an empty --terminal instead of consuming the ambient mailbox', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'

    await expect(
      invokeCheck(new Map<string, string | boolean>([['terminal', '']]))
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(callMock).not.toHaveBeenCalled()
  })
})
