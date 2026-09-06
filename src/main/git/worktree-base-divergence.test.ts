import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ gitExecFileAsync: vi.fn() }))

vi.mock('./runner', () => ({ gitExecFileAsync: mocks.gitExecFileAsync }))

import { GIT_READ_TIMEOUT_MS } from './command-runner/git-command-timeout'
import { WSL_GIT_READ_ENVIRONMENT_WAIT_MS } from './wsl-git-read-environment'
import {
  measureRetargetDivergence,
  RETARGET_DIVERGENCE_BUDGET_MS
} from './worktree-base-divergence'

type ExecOptions = { cwd: string; timeout?: number; wslDistro?: string; signal?: AbortSignal }

function callOptions(): ExecOptions[] {
  return mocks.gitExecFileAsync.mock.calls.map((call) => call[1] as ExecOptions)
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
  it('puts every probe under one shared budget, not a budget each', async () => {
    answerProbes('3\n')

    await expect(
      measureRetargetDivergence('/repo', 'refs/heads/main', 'refs/remotes/origin/main')
    ).resolves.toBe('within')

    expect(subcommands()).toEqual(['rev-list', 'rev-list', 'merge-base'])
    const signals = callOptions().map((options) => options.signal)
    // One signal object across all three: the counts and merge-base are staged, so per-probe
    // budgets would let the check cost the sum of them.
    expect(new Set(signals).size).toBe(1)
    expect(signals[0]).toBeInstanceOf(AbortSignal)
  })

  it('also gives each probe a command timeout well below git default read deadline', async () => {
    answerProbes('3\n')

    await measureRetargetDivergence('/repo', 'refs/heads/main', 'refs/remotes/origin/main')

    // The signal covers admission queueing and the WSL environment wait, which start before a
    // command timeout exists; the timeout still covers a hung spawn.
    for (const options of callOptions()) {
      expect(options.timeout).toBe(RETARGET_DIVERGENCE_BUDGET_MS)
    }
    expect(RETARGET_DIVERGENCE_BUDGET_MS).toBeLessThan(GIT_READ_TIMEOUT_MS)
  })

  it('really aborts the in-flight probes when the shared budget expires', async () => {
    // A probe that behaves like a slow walk: it produces nothing on its own and only settles when
    // its signal fires. If the budget never fired, or never reached the probe, this hangs and the
    // test fails on its own timeout rather than passing on a signal that does nothing.
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

  it('clears the WSL read-environment wait, which starts before any command timeout', () => {
    // Equal to it would make the first WSL-routed create of a session `unknown` by construction,
    // and the WSL numbers meaningless.
    expect(RETARGET_DIVERGENCE_BUDGET_MS).toBeGreaterThan(WSL_GIT_READ_ENVIRONMENT_WAIT_MS)
    expect(RETARGET_DIVERGENCE_BUDGET_MS).toBeLessThan(GIT_READ_TIMEOUT_MS)
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
    // A count that never answered must not go on to spend a merge-base walk.
    expect(subcommands()).not.toContain('merge-base')
  })

  it('separates merge-base saying no from merge-base failing', async () => {
    mocks.gitExecFileAsync.mockImplementation(async (args: string[]) => {
      if (args[0] === 'merge-base') {
        // Exit 1 is Git's answer for unrelated histories.
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
        // A timeout carries no exit code and must not be read as "no common ancestor".
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

  it('routes every probe to the caller-named WSL distro', async () => {
    answerProbes('1\n')

    await measureRetargetDivergence('/repo', 'refs/heads/main', 'refs/remotes/origin/main', {
      wslDistro: 'Ubuntu'
    })

    for (const options of callOptions()) {
      expect(options).toMatchObject({ cwd: '/repo', wslDistro: 'Ubuntu' })
    }
  })
})
