import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: vi.fn(),
  spawn: vi.fn()
}))
vi.mock('../../observability/instrumentation', () => ({
  withGitSpan: (_attributes: unknown, run: (span: unknown) => unknown) =>
    run({ setAttribute: () => {} })
}))
vi.mock('../../diagnostics/main-thread-churn-probe', () => ({ recordSubprocessSpawn: vi.fn() }))

import { gitExecFileAsync } from '../runner'
import {
  peekWslGitReadEnvironment,
  resetWslGitReadEnvironmentForTests,
  seedWslGitReadEnvironmentForTests
} from '../wsl-git-read-environment'
import { _resetGitAdmissionForTests } from './git-subprocess-admission'
import { resetTransientWslServiceBreakerForTests } from './wsl-host-failure'

const WSL_DIAGNOSTIC =
  'There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n'

function hostFailure(stdout: string): Error {
  return Object.assign(new Error('Command failed: wsl.exe -d kali-linux --exec sh -lc ...'), {
    code: 4294967295,
    stdout,
    stderr: ''
  })
}

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await run()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('git reads over wsl.exe on a booting distro', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    resetTransientWslServiceBreakerForTests()
  })
  afterEach(() => {
    _resetGitAdmissionForTests()
  })

  const TRANSIENT = 'Catastrophic failure \r\nError code: Wsl/Service/E_UNEXPECTED\r\n'

  function answerWith(results: ({ fail: string } | { stdout: string })[]): void {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      const child = Object.assign(new EventEmitter(), { pid: 4321, kill: () => {} })
      const next = results.shift() ?? { stdout: '' }
      queueMicrotask(() =>
        'fail' in next
          ? callback?.(hostFailure(next.fail), next.fail, '')
          : callback?.(null, next.stdout, '')
      )
      return child
    })
  }

  const UNC = '\\\\wsl.localhost\\kali-linux\\home\\paulius\\bugbounty'
  const listWorktrees = (options: { signal?: AbortSignal } = {}) =>
    withPlatform('win32', () =>
      gitExecFileAsync(['worktree', 'list', '--porcelain', '-z'], { cwd: UNC, ...options }).then(
        (result) => result.stdout,
        (error: unknown) => error
      )
    )

  describe('transient WSL service errors', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      resetTransientWslServiceBreakerForTests()
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('retries a read until the booting distro answers', async () => {
      answerWith([{ fail: TRANSIENT }, { fail: TRANSIENT }, { stdout: 'worktree /x\0' }])
      const result = listWorktrees()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await result).toBe('worktree /x\0')
      expect(execFileMock).toHaveBeenCalledTimes(3)
    })

    it('gives up after the bounded retries, then fails fast on that distro for a while', async () => {
      answerWith([
        { fail: TRANSIENT },
        { fail: TRANSIENT },
        { fail: TRANSIENT },
        { fail: TRANSIENT }
      ])
      const first = listWorktrees()
      await vi.advanceTimersByTimeAsync(2_500)
      expect(String(await first)).toContain('Wsl/Service/E_UNEXPECTED')
      expect(execFileMock).toHaveBeenCalledTimes(4)

      answerWith([{ fail: TRANSIENT }])
      expect(String(await listWorktrees())).toContain('Wsl/Service/E_UNEXPECTED')
      expect(execFileMock).toHaveBeenCalledTimes(5)
    })

    it('stops waiting as soon as the caller aborts', async () => {
      answerWith([{ fail: TRANSIENT }, { stdout: 'never' }])
      const controller = new AbortController()
      const result = listWorktrees({ signal: controller.signal })
      await vi.advanceTimersByTimeAsync(100)
      controller.abort()
      expect(await result).toMatchObject({ name: 'AbortError' })
      expect(execFileMock).toHaveBeenCalledTimes(1)
    })

    it('never re-runs a write, or a read that failed for another reason', async () => {
      answerWith([{ fail: TRANSIENT }])
      await withPlatform('win32', () =>
        gitExecFileAsync(['commit', '-m', 'x'], { cwd: UNC }).catch(() => null)
      )
      expect(execFileMock).toHaveBeenCalledTimes(1)

      execFileMock.mockReset()
      answerWith([{ fail: WSL_DIAGNOSTIC }])
      await listWorktrees()
      expect(execFileMock).toHaveBeenCalledTimes(1)
    })
  })

  it('keeps the direct read path when a direct read only hit a transient service error', async () => {
    vi.useRealTimers()
    await withPlatform('win32', async () => {
      const environment = { gitPath: '/usr/bin/git', home: '/home/u', path: '/usr/bin:/bin' }
      seedWslGitReadEnvironmentForTests('Ubuntu', environment)
      answerWith([
        { fail: TRANSIENT },
        { fail: TRANSIENT },
        { fail: TRANSIENT },
        { fail: TRANSIENT }
      ])
      const failure = await gitExecFileAsync(['status', '--short'], {
        cwd: String.raw`C:\repo`,
        preferWslDirectGit: true,
        wslDistro: 'Ubuntu'
      }).catch((error: unknown) => error)
      expect(String(failure)).toContain('Wsl/Service/E_UNEXPECTED')
      // Four direct launches and no login-shell fallback, so the fast path stays on.
      expect(execFileMock).toHaveBeenCalledTimes(4)
      expect(peekWslGitReadEnvironment('Ubuntu')).toEqual(environment)
    }).finally(resetWslGitReadEnvironmentForTests)
  }, 15_000)
})
