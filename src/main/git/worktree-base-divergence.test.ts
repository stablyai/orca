import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ gitExecFileAsync: vi.fn() }))

vi.mock('./runner', () => ({ gitExecFileAsync: mocks.gitExecFileAsync }))

import { GitAdmissionScheduler } from './command-runner/git-subprocess-admission'
import type { GitAdmissionTier } from './command-runner/git-exec-options'

import { measureRetargetDivergence } from './worktree-base-divergence'

type ExecOptions = {
  cwd: string
  timeout?: number
  wslDistro?: string
  signal?: AbortSignal
  admissionTier?: GitAdmissionTier
}

function subcommands(): string[] {
  return mocks.gitExecFileAsync.mock.calls.map((call) => (call[0] as string[])[0]!)
}

function answerProbes(count: string, mergeBase = 'abc123\n') {
  mocks.gitExecFileAsync.mockImplementation(async (args: string[]) =>
    args[0] === 'merge-base' ? { stdout: mergeBase } : { stdout: count }
  )
}

function exitCodeError(code: number): Error & { code: number } {
  return Object.assign(new Error('git exited'), { code })
}

beforeEach(() => {
  mocks.gitExecFileAsync.mockReset()
})

describe('measureRetargetDivergence deadlines', () => {
  it('finishes through interactive headroom while general capacity is occupied', async () => {
    const scheduler = new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 1 })
    const blocker = await scheduler.acquire({ args: ['status'], cwd: '/repo' })
    mocks.gitExecFileAsync.mockImplementation(async (args: string[], options: ExecOptions) => {
      const grant = await scheduler.acquire({
        args,
        cwd: options.cwd,
        signal: options.signal,
        tier: options.admissionTier
      })
      try {
        return { stdout: args[0] === 'merge-base' ? 'abc123\n' : '1\n' }
      } finally {
        grant.release()
      }
    })
    try {
      await expect(
        measureRetargetDivergence('/repo', 'refs/heads/main', 'refs/remotes/origin/main', {
          admissionTier: 'interactive',
          budgetMsForTest: 200
        })
      ).resolves.toBe('within')
      expect(subcommands()).toEqual(['rev-list', 'rev-list', 'merge-base'])
    } finally {
      blocker.release()
    }
  })

  it('really aborts the in-flight probes when the shared budget expires', async () => {
    mocks.gitExecFileAsync.mockImplementation(
      (_args: string[], options: ExecOptions) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () =>
              reject(
                Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
              ),
            { once: true }
          )
        })
    )

    await expect(
      measureRetargetDivergence('/repo', 'refs/heads/main', 'refs/remotes/origin/main', {
        budgetMsForTest: 25
      })
    ).resolves.toBe('unknown')
  })

  it('stops the probes when the create itself is cancelled, without waiting for the budget', async () => {
    mocks.gitExecFileAsync.mockImplementation(
      (_args: string[], options: ExecOptions) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () =>
              reject(
                Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
              ),
            { once: true }
          )
        })
    )
    const controller = new AbortController()
    const pending = measureRetargetDivergence(
      '/repo',
      'refs/heads/main',
      'refs/remotes/origin/main',
      // A budget long enough that only the caller's cancellation can end this in time.
      { signal: controller.signal, budgetMsForTest: 60_000 }
    )
    controller.abort()

    await expect(pending).resolves.toBe('unknown')
  })

  it('reports a blown deadline as unverifiable rather than as excess drift', async () => {
    mocks.gitExecFileAsync.mockRejectedValue(new Error('git timed out.'))

    await expect(
      measureRetargetDivergence('/repo', 'refs/heads/main', 'refs/remotes/origin/main')
    ).resolves.toBe('unknown')
    expect(subcommands()).not.toContain('merge-base')
  })

  it('separates merge-base saying no from merge-base failing', async () => {
    mocks.gitExecFileAsync.mockImplementation(async (args: string[]) => {
      if (args[0] === 'merge-base') {
        throw exitCodeError(1)
      }
      return { stdout: '2\n' }
    })
    await expect(
      measureRetargetDivergence('/repo', 'refs/heads/main', 'refs/remotes/origin/main')
    ).resolves.toBe('exceeded')

    mocks.gitExecFileAsync.mockReset()
    mocks.gitExecFileAsync.mockImplementation(async (args: string[]) => {
      if (args[0] === 'merge-base') {
        throw new Error('git timed out.')
      }
      return { stdout: '2\n' }
    })
    await expect(
      measureRetargetDivergence('/repo', 'refs/heads/main', 'refs/remotes/origin/main')
    ).resolves.toBe('unknown')
  })

  it('reports drift past the cap without spending a merge-base walk', async () => {
    answerProbes('101\n')

    await expect(
      measureRetargetDivergence('/repo', 'refs/heads/main', 'refs/remotes/origin/main')
    ).resolves.toBe('exceeded')
    expect(subcommands()).not.toContain('merge-base')
  })
})
