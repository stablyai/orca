import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))

vi.mock('../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))

import { _gitOperationLockHeldForTests } from '../shared/git-operation-lock'
import { _resolveGitWorktreeAdminLockKeyForTests } from '../shared/git-worktree-admin-lock'
import { createGitHandlerRelay } from './git-handler-test-harness'

type GitTerminationTarget = {
  git(
    args: string[],
    cwd: string,
    options: { signal?: AbortSignal; terminationBarrier: true; timeout?: number }
  ): Promise<{ stdout: string; stderr: string }>
}

describe('GitHandler termination barrier', () => {
  beforeEach(() => runProcessMock.mockReset())

  it('rejects a zero-exit result that crossed its timeout', async () => {
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: true
    })
    const { handler } = createGitHandlerRelay()
    const target = handler as unknown as GitTerminationTarget

    await expect(
      target.git(['status'], '/repo', { terminationBarrier: true, timeout: 1 })
    ).rejects.toThrow('git status timed out.')
  })

  it('rejects a zero-exit result after caller cancellation', async () => {
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    })
    const controller = new AbortController()
    controller.abort()
    const { handler } = createGitHandlerRelay()
    const target = handler as unknown as GitTerminationTarget

    await expect(
      target.git(['status'], '/repo', {
        signal: controller.signal,
        terminationBarrier: true
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('runs a worktree admin command to termination and holds its lane until then', async () => {
    const exited = Promise.withResolvers<unknown>()
    runProcessMock.mockReturnValue(exited.promise)
    const { handler } = createGitHandlerRelay()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `git` is the handler's private command runner; the harness constructs a real GitHandler.
    const target = handler as unknown as {
      git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }>
    }
    const key = await _resolveGitWorktreeAdminLockKeyForTests('/repo')

    const pending = target.git(['worktree', 'prune'], '/repo')
    await vi.waitFor(() => expect(runProcessMock).toHaveBeenCalledOnce())
    expect(_gitOperationLockHeldForTests(key)).toBe(true)

    exited.resolve({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false })
    await expect(pending).resolves.toEqual({ stdout: '', stderr: '' })
    expect(_gitOperationLockHeldForTests(key)).toBe(false)
  })
})
