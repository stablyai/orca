import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  realpath: async (path: string) => path
}))
import type { GitExecOptions } from '../command-runner/git-exec-options'
import { clearGitCapabilityStateForTests } from '../command-runner/host-routing/git-capability-state'
import { resolveConflict } from '../source-control/mutations/staging'
import { gitFastForward, gitPull, gitPush } from './remote'

describe('git remote operations', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    clearGitCapabilityStateForTests()
  })

  it('preserves redacted pre-push hook output from failed pushes', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('no branch'))
      .mockRejectedValueOnce(
        new Error(
          [
            'Command failed: git push https://x-access-token:ghp_secret@github.com/acme/repo.git HEAD',
            'husky - pre-push hook failed',
            'eslint found 2 errors',
            "error: failed to push some refs to 'https://ghp_tailSecret@github.com/acme/repo.git'"
          ].join('\n')
        )
      )

    let caught: Error | undefined
    try {
      await gitPush('/repo', false)
    } catch (error) {
      caught = error as Error
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught?.message).toContain('husky - pre-push hook failed')
    expect(caught?.message).toContain('eslint found 2 errors')
    expect(caught?.message).not.toContain('x-access-token')
    expect(caught?.message).not.toContain('ghp_secret')
    expect(caught?.message).not.toContain('ghp_tailSecret')
  })

  it.each([
    ['pull', gitPull],
    ['fast-forward', gitFastForward]
  ] as const)(
    'retains the Windows %s lane after cancellation until its writer ends',
    async (_name, pull) => {
      const platform = process.platform
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const started = Promise.withResolvers<void>()
      const writer = Promise.withResolvers<void>()
      const captured = Promise.withResolvers<{ stdout: string; stderr: string }>()
      const controller = new AbortController()
      gitExecFileAsyncMock.mockImplementation((args: string[], options: GitExecOptions) => {
        if (args[0] === 'pull') {
          options.observeChildTermination?.(writer.promise, true)
          options.signal?.addEventListener('abort', () => captured.reject(new Error('cancelled')), {
            once: true
          })
          started.resolve()
          return captured.promise
        }
        return Promise.resolve({ stdout: '', stderr: '' })
      })
      const first = pull('/repo', undefined, { signal: controller.signal })
      const rejected = expect(first).rejects.toThrow('cancelled')
      let successor: Promise<unknown> | undefined
      try {
        await started.promise
        controller.abort()
        await rejected
        successor = resolveConflict('/repo', 'file.txt', 'keep_file').catch(
          (error: unknown) => error
        )
        await expect(resolveConflict('/other', 'file.txt', 'keep_file')).rejects.toBeInstanceOf(
          Error
        )
        expect(await Promise.race([successor, Promise.resolve('writer still running')])).toBe(
          'writer still running'
        )
        writer.resolve()
        await expect(successor).resolves.toBeInstanceOf(Error)
      } finally {
        writer.resolve()
        captured.resolve({ stdout: '', stderr: '' })
        await Promise.allSettled([first, ...(successor ? [successor] : [])])
        Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      }
    }
  )
})
