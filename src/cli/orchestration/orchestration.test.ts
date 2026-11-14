import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const getTerminalHandleMock = vi.hoisted(() => vi.fn())
const originalExitCode = process.exitCode

vi.mock('../output/command-result-output', () => ({ printResult: vi.fn() }))
vi.mock('../terminals/terminal-selector', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration-handlers'

import { printResult } from '../output/command-result-output'
import { okFixture } from '../runtime/fixtures/runtime-rpc-fixtures'

beforeEach(() => {
  callMock.mockReset()
  getTerminalHandleMock.mockReset()
  vi.mocked(printResult).mockReset()
  vi.stubEnv('ORCA_TERMINAL_HANDLE', undefined)
  vi.stubEnv('ORCA_PANE_KEY', undefined)
  vi.stubEnv('ORCA_STRUCTURED_SESSION', undefined)
  vi.stubEnv('ORCA_AGENT_SESSION_ID', undefined)
  vi.stubEnv('ORCA_CLI_COMMAND', undefined)
  vi.stubEnv('ORCA_WINDOWS_PACKAGED_CLI_LAUNCHER', undefined)
  vi.stubEnv('ORCA_DEV_CLI_INVOCATION', undefined)
  vi.stubEnv('ORCA_USER_DATA_PATH', undefined)
  process.exitCode = undefined
})

afterEach(() => {
  process.exitCode = originalExitCode
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('orchestration send structured payload flags', () => {
  beforeEach(() => {
    callMock.mockResolvedValue(
      okFixture('req_send', { message: { id: 'msg_sent' }, lifecycle: { action: 'completed' } })
    )
  })

  const invokeSend = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration send']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

  it('refuses a structured session without naming a handle it could pass', async () => {
    process.env.ORCA_STRUCTURED_SESSION = '1'
    getTerminalHandleMock.mockResolvedValue('term_sibling_pane')

    // --from bypasses this guard and could select another pane; never recommend it as recovery.
    await expect(
      invokeSend(
        new Map<string, string | boolean>([
          ['to', 'term_coord'],
          ['subject', 'done'],
          ['type', 'worker_done'],
          ['outcome', 'succeeded']
        ])
      )
    ).rejects.toMatchObject({
      code: 'no_active_sender_terminal',
      message: expect.not.stringContaining('Pass --from')
    })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
    expect(callMock).not.toHaveBeenCalled()
  })
})

describe('orchestration timeout flag validation', () => {
  const invokeCheck = (flags: Map<string, string | boolean>) =>
    ORCHESTRATION_HANDLERS['orchestration check']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

  it('fails --peek --wait against a runtime that returned only read rows', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    callMock.mockResolvedValue({
      result: {
        messages: [{ id: 'msg_old', from_handle: 'a', subject: 'seen', read: 1 }],
        count: 1
      }
    })

    await expect(
      invokeCheck(
        new Map<string, string | boolean>([
          ['peek', true],
          ['wait', true]
        ])
      )
    ).rejects.toMatchObject({ code: 'peek_wait_unsupported' })
  })
})

describe('orchestration inbox scoped reads', () => {
  const invokeInbox = (flags: Map<string, string | boolean>, json = true) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this handler test provides every context field it reads.
    ORCHESTRATION_HANDLERS['orchestration inbox']({
      flags,
      client: { call: callMock },
      cwd: '/tmp/repo',
      json
    } as never)

  it('rejects a Run-scoped inbox response from a runtime that only read terminal mail', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    callMock.mockResolvedValue({
      result: {
        messages: [],
        count: 0,
        scope: 'messages addressed to terminal term_worker'
      }
    })
    vi.mocked(printResult).mockClear()

    await expect(
      invokeInbox(new Map<string, string | boolean>([['run', 'run_1']]))
    ).rejects.toMatchObject({
      code: 'incompatible_runtime',
      message:
        'The running Orca runtime does not support Run-scoped inbox reads. Update or restart Orca and try again.'
    })
    expect(printResult).not.toHaveBeenCalled()
  })

  it('keeps the empty inbox scope and Run binding in the default view', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    callMock.mockResolvedValue({
      result: {
        messages: [],
        count: 0,
        scope: 'messages addressed to Run run_1',
        runBinding: 'run_1'
      }
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const flags = new Map<string, string | boolean>([['run', 'run_1']])

    await invokeInbox(flags)

    const printed = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))
    expect(printed.result).toMatchObject({
      messages: [],
      scope: 'messages addressed to Run run_1',
      runBinding: 'run_1'
    })

    logSpy.mockClear()
    await invokeInbox(flags, false)
    expect(logSpy.mock.calls.at(-1)?.[0]).toBe(
      'No messages addressed to Run run_1. Current Run binding: run_1.'
    )
    logSpy.mockRestore()
  })
})
