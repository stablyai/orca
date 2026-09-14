import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))

vi.mock('../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))

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
})
