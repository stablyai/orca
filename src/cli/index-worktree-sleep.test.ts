import { describe, expect, it, vi } from 'vitest'

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
import { buildWorktree, okFixture, queueFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

const TARGET_ID = 'repo::/tmp/repo/feature'

async function runSleep(args: string[]): Promise<{ output: string; exitCode: number }> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const priorExitCode = process.exitCode
  process.exitCode = 0
  await main(['worktree', 'sleep', ...args], '/tmp/elsewhere')
  const exitCode = Number(process.exitCode ?? 0)
  process.exitCode = priorExitCode
  return { output: [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n'), exitCode }
}

describe('orca worktree sleep', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('sleeps the selected worktree and reports the request', async () => {
    queueFixtures(callMock, okFixture('req_sleep', { worktreeId: TARGET_ID }))

    const { output, exitCode } = await runSleep(['--worktree', `id:${TARGET_ID}`, '--json'])

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('worktree.sleep', { worktree: `id:${TARGET_ID}` })
    expect(JSON.parse(output).result).toEqual({ worktreeId: TARGET_ID })
    expect(exitCode).toBe(0)
  })

  it('sleeps another worktree when run from an Orca terminal', async () => {
    process.env.ORCA_WORKTREE_ID = 'repo::/tmp/repo'
    queueFixtures(
      callMock,
      okFixture('req_show', { worktree: buildWorktree('/tmp/repo/feature', 'feature/foo') }),
      okFixture('req_sleep', { worktreeId: TARGET_ID })
    )

    const { output } = await runSleep(['--worktree', `id:${TARGET_ID}`])

    expect(callMock).toHaveBeenLastCalledWith('worktree.sleep', { worktree: `id:${TARGET_ID}` })
    expect(output).toContain(`sleep requested: ${TARGET_ID}`)
  })

  // Why: the caller's own PTY is one of the terminals sleep stops, so the command would kill itself.
  it('refuses to sleep the worktree whose terminal runs the command', async () => {
    process.env.ORCA_WORKTREE_ID = TARGET_ID
    queueFixtures(
      callMock,
      okFixture('req_show', { worktree: buildWorktree('/tmp/repo/feature', 'feature/foo') })
    )

    const { output, exitCode } = await runSleep(['--worktree', `id:${TARGET_ID}`, '--json'])

    expect(JSON.parse(output).error.code).toBe('invalid_argument')
    expect(JSON.parse(output).error.message).toContain('--force')
    expect(callMock).not.toHaveBeenCalledWith('worktree.sleep', expect.anything())
    expect(exitCode).toBe(1)
  })

  it('sleeps the caller worktree with --force', async () => {
    process.env.ORCA_WORKTREE_ID = TARGET_ID
    queueFixtures(callMock, okFixture('req_sleep', { worktreeId: TARGET_ID }))

    await runSleep(['--worktree', `id:${TARGET_ID}`, '--force', '--json'])

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('worktree.sleep', { worktree: `id:${TARGET_ID}` })
  })

  it('names the version gap when the host predates worktree.sleep', async () => {
    const { RuntimeClientError } = await import('./runtime/types.js')
    callMock.mockRejectedValueOnce(
      new RuntimeClientError('method_not_found', 'Unknown method: worktree.sleep')
    )

    const { output, exitCode } = await runSleep(['--worktree', `id:${TARGET_ID}`, '--json'])

    expect(JSON.parse(output).error.code).toBe('incompatible_runtime')
    expect(output).not.toContain('Unknown method')
    expect(exitCode).toBe(1)
  })
})
