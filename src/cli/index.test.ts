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
import { okFixture, queueFixtures } from './test-fixtures'

describe('command aliases dispatch to the canonical handler', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    callMock.mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    callMock.mockReset()
    // Restore the spy so later describe blocks cannot inherit these calls.
    logSpy.mockRestore()
  })

  it('fails closed when worktree removal cannot resolve a host', async () => {
    queueFixtures(callMock, okFixture('req_show', { worktree: { id: 'wt-1' } }))
    const priorExitCode = process.exitCode

    try {
      await main(['worktree', 'rm', '--worktree', 'id:wt-1', '--json'], '/tmp/repo')

      expect(process.exitCode).toBe(1)
      expect(callMock).toHaveBeenCalledTimes(1)
      expect(callMock).toHaveBeenCalledWith('worktree.show', { worktree: 'id:wt-1' })
      expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toMatchObject({
        ok: false,
        error: { code: 'worktree_host_unresolved' }
      })
    } finally {
      process.exitCode = priorExitCode
    }
  })

  it('rejects the archive-hook waiver without --run-hooks instead of ignoring it', async () => {
    queueFixtures(callMock, okFixture('req_show', { worktree: { hostId: 'local' } }))
    const priorExitCode = process.exitCode

    try {
      await main(
        ['worktree', 'rm', '--worktree', 'id:wt-1', '--allow-failed-archive-hook', '--json'],
        '/tmp/repo'
      )

      expect(process.exitCode).toBe(1)
      expect(callMock).not.toHaveBeenCalledWith('worktree.rm', expect.anything())
      expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toMatchObject({
        ok: false,
        error: {
          code: 'invalid_argument',
          message: expect.stringContaining('without --run-hooks no hook runs at all')
        }
      })
    } finally {
      process.exitCode = priorExitCode
    }
  })

  it('documents that terminal wait --for exit needs exec', async () => {
    await main(['terminal', 'create', '--help'], '/tmp/repo')
    expect(String(logSpy.mock.calls[0][0])).toContain('prefix --command with exec')

    logSpy.mockClear()
    await main(['terminal', 'wait', '--help'], '/tmp/repo')
    expect(String(logSpy.mock.calls[0][0])).toContain(
      'Prefix terminal create --command with exec so the command replaces the shell'
    )
    expect(callMock).not.toHaveBeenCalled()
  })
})
