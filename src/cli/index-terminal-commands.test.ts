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
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  listEnvironments: listEnvironmentsMock
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('orca cli worktree awareness', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  const originalExitCode = process.exitCode
  beforeEach(() => {
    process.exitCode = undefined
    runtimeClientConstructorMock.mockClear()
  })
  afterEach(() => {
    process.exitCode = originalExitCode
  })

  it('rejects implicit remote terminal create instead of resolving from client cwd', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      ['terminal', 'create', '--pairing-code', 'remote-runtime', '--json'],
      '/tmp/client/repo/src'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_argument',
        message:
          'Remote terminal create requires --worktree because the client cwd cannot identify a server worktree.'
      }
    })
    expect(errSpy).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('rejects an empty --terminal instead of sending to the active pane', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'send', '--terminal', '', '--text', 'x', '--json'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
    expect(process.exitCode).toBe(1)
  })

  it('exits nonzero when terminal wait returns an unsatisfied blocked result', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    callMock.mockResolvedValueOnce({
      id: 'req_terminal_wait',
      ok: true,
      result: {
        wait: {
          handle: 'term_worker',
          condition: 'tui-idle',
          satisfied: false,
          status: 'running',
          exitCode: null,
          blockedReason: 'codex-cwd-prompt'
        }
      },
      _meta: {
        runtimeId: 'runtime-1'
      }
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'wait', '--terminal', 'term_worker', '--for', 'tui-idle'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith(
      'terminal.wait',
      {
        terminal: 'term_worker',
        for: 'tui-idle',
        timeoutMs: undefined
      },
      {
        timeoutMs: 300000
      }
    )
    expect(logSpy.mock.calls.flat().join('\n')).toContain('blockedReason: codex-cwd-prompt')
    expect(process.exitCode).toBe(1)
  })
})
