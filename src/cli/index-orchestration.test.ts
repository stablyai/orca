import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('orca cli worktree awareness', () => {
  const priorExitCode = process.exitCode
  beforeEach(() => {
    process.exitCode = undefined
  })
  afterEach(() => {
    process.exitCode = priorExitCode
    vi.unstubAllEnvs()
  })
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it.each([
    { questionFlag: '--question', questionValue: 'Proceed?', json: true },
    { questionFlag: '--resume', questionValue: 'msg_pending', json: false }
  ])('reports oversized ask waits before any request: %o', async (testCase) => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    callMock.mockResolvedValue({
      id: 'req_ask',
      ok: true,
      result: { answer: 'yes', messageId: 'msg_1', threadId: 'msg_1', timedOut: false },
      _meta: { runtimeId: 'runtime-1' }
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      [
        'orchestration',
        'ask',
        testCase.questionFlag,
        testCase.questionValue,
        '--timeout-ms',
        '14400000',
        ...(testCase.json ? ['--json'] : [])
      ],
      '/tmp/repo'
    )

    expect(process.exitCode).toBe(1)
    expect(callMock).not.toHaveBeenCalled()
    if (testCase.json) {
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(JSON.parse(logSpy.mock.calls[0][0])).toMatchObject({
        ok: false,
        error: {
          code: 'invalid_argument',
          message: expect.stringMatching(/--timeout-ms.*1800000.*30 minutes/)
        }
      })
    } else {
      expect(logSpy).not.toHaveBeenCalled()
    }
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^error: invalid_argument: --timeout-ms.*1800000.*30 minutes/)
    )
  })

  it("refuses an agent session's caller flag naming another caller before any request", async () => {
    vi.stubEnv('ORCA_AGENT_SESSION_ID', 'f7a1c0de-1111-4222-8333-444455556666')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['orchestration', 'check', '--terminal', 'term_sibling', '--json'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'consumer_fenced' }
    })
  })

  it('rejects no-flag orchestration reset before calling the runtime', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await main(['orchestration', 'reset'], '/tmp/repo')

    expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
      'error: invalid_argument: Choose exactly one reset scope: --all, --tasks, or --messages.'
    )
    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it.each([
    ['orchestration', 'reset', '--tasks', '--messages'],
    ['orchestration', 'reset', '--all', '--tasks']
  ])('rejects conflicting reset scopes for $args', async (...args) => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main([...args, '--json'], '/tmp/repo')

    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message: 'Choose exactly one reset scope: --all, --tasks, or --messages.'
      }
    })
    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('rejects unknown task-update status with an enum-aware error', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      ['orchestration', 'task-update', '--id', 'task_x', '--status', 'complete'],
      '/tmp/repo'
    )

    const output = [...errSpy.mock.calls, ...logSpy.mock.calls]
      .flat()
      .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
      .join('\n')
    expect(output).toContain("invalid status 'complete'")
    expect(output).toContain('pending, ready, dispatched, completed, failed, blocked')
    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })
})
