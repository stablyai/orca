import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { callMock, getTerminalHandleMock } = vi.hoisted(() => ({
  callMock: vi.fn(),
  getTerminalHandleMock: vi.fn()
}))

vi.mock('../runtime-client', async () => {
  // Why: re-export the REAL error classes so format.ts `instanceof` narrowing still matches.
  const { RuntimeClientError, RuntimeRpcFailureError } = await import('../runtime/types.js')
  class RuntimeClient {
    readonly isRemote = false
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }
  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError,
    serveOrcaApp: vi.fn(),
    getDefaultUserDataPath: vi.fn(() => '/tmp/orca-user-data')
  }
})

vi.mock('../selectors', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTerminalHandle: getTerminalHandleMock
}))

import { main } from '../index'
import { RuntimeClientError } from '../runtime/types'
import { okFixture, queueFixtures } from '../test-fixtures'

const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
const originalPaneKey = process.env.ORCA_PANE_KEY

const restoreEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

describe('orchestration gate commands carry caller identity', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PANE_KEY
    process.exitCode = 0
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
    restoreEnv('ORCA_TERMINAL_HANDLE', originalTerminalHandle)
    restoreEnv('ORCA_PANE_KEY', originalPaneKey)
    process.exitCode = 0
  })

  const paramsFor = (method: string): Record<string, unknown> =>
    callMock.mock.calls.find((call) => call[0] === method)?.[1] as Record<string, unknown>

  it('sends the bound coordinator handle to gateCreate', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    queueFixtures(
      callMock,
      okFixture('req_show', { terminal: { handle: 'term_coord' } }),
      okFixture('req_gate', { gate: { id: 'gate_1', task_id: 'task_1', status: 'pending' } })
    )

    await main(
      ['orchestration', 'gate-create', '--task', 'task_1', '--question', 'ship?', '--json'],
      '/tmp/repo'
    )

    expect(process.exitCode).toBe(0)
    expect(paramsFor('orchestration.gateCreate')).toEqual(
      expect.objectContaining({ task: 'task_1', question: 'ship?', from: 'term_coord' })
    )
  })

  it('remints a stale environment handle before authorizing gateCreate', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_stale'
    process.env.ORCA_PANE_KEY = 'tab_coord:leaf_coord'
    callMock.mockImplementation(async (method: string) => {
      if (method === 'terminal.show') {
        throw new RuntimeClientError('terminal_handle_stale', 'stale')
      }
      if (method === 'terminal.resolvePane') {
        return okFixture('req_pane', { terminal: { handle: 'term_live' } })
      }
      return okFixture('req_gate', {
        gate: { id: 'gate_1', task_id: 'task_1', status: 'pending' }
      })
    })

    await main(
      ['orchestration', 'gate-create', '--task', 'task_1', '--question', 'ship?', '--json'],
      '/tmp/repo'
    )

    expect(paramsFor('orchestration.gateCreate')).toEqual(
      expect.objectContaining({ from: 'term_live' })
    )
  })

  it('accepts an explicit --from without probing terminal liveness', async () => {
    queueFixtures(
      callMock,
      okFixture('req_gate', {
        gate: { id: 'gate_1', task_id: 'task_1', status: 'resolved', resolution: 'go' }
      })
    )

    await main(
      [
        'orchestration',
        'gate-resolve',
        '--id',
        'gate_1',
        '--resolution',
        'go',
        '--from',
        'term_explicit',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(process.exitCode).toBe(0)
    expect(callMock).toHaveBeenCalledTimes(1)
    expect(paramsFor('orchestration.gateResolve')).toEqual(
      expect.objectContaining({ id: 'gate_1', resolution: 'go', from: 'term_explicit' })
    )
  })

  it('scopes gate-list to the caller when no Run is named', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    queueFixtures(
      callMock,
      okFixture('req_show', { terminal: { handle: 'term_coord' } }),
      okFixture('req_list', { gates: [], count: 0 })
    )

    await main(['orchestration', 'gate-list', '--json'], '/tmp/repo')

    expect(process.exitCode).toBe(0)
    expect(paramsFor('orchestration.gateList')).toEqual(
      expect.objectContaining({ from: 'term_coord', run: undefined })
    )
  })

  it('inspects a named Run without resolving a caller terminal', async () => {
    // Why: read-only inspection must stay reachable from a pane with no bound Run.
    getTerminalHandleMock.mockRejectedValue(
      new RuntimeClientError('no_active_terminal', 'no active terminal')
    )
    queueFixtures(
      callMock,
      okFixture('req_list', {
        gates: [{ id: 'gate_1', task_id: 'task_1', question: 'ship?', status: 'pending' }],
        count: 1
      })
    )

    await main(['orchestration', 'gate-list', '--run', 'run_adopted', '--json'], '/tmp/repo')

    expect(process.exitCode).toBe(0)
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(paramsFor('orchestration.gateList')).toEqual(
      expect.objectContaining({ run: 'run_adopted', from: undefined })
    )
  })

  it('fails an unbound gate-create with an actionable error and no mutation', async () => {
    getTerminalHandleMock.mockRejectedValue(
      new RuntimeClientError('no_active_terminal', 'no active terminal')
    )

    await main(
      ['orchestration', 'gate-create', '--task', 'task_1', '--question', 'ship?'],
      '/tmp/repo'
    )

    expect(process.exitCode).toBe(1)
    const stderr = errorSpy.mock.calls.map((call) => String(call[0])).join('\n')
    expect(stderr).toContain('Pass --from <terminal-handle>')
    expect(callMock).not.toHaveBeenCalledWith('orchestration.gateCreate', expect.anything())
  })
})
