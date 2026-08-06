import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildGitBranchLineTotalDiffArgs,
  invalidateGitBranchLineTotalInFlight
} from '../../shared/git-branch-line-total'

import type * as BranchLineTotal from '../../shared/git-branch-line-total'
import type * as GitRunner from './runner'

// Why: real git, spied argv. Every exec is recorded so the performance contract
// ("no ranged diff unless asked", "one exec for concurrent callers") can be
// asserted on the actual command list rather than on a stubbed return value.
const { gitExecCalls, execHooks, coalescerJoins } = vi.hoisted(() => ({
  gitExecCalls: [] as string[][],
  execHooks: { beforeExec: undefined as undefined | ((args: string[]) => Promise<void> | void) },
  coalescerJoins: { count: 0, onJoin: undefined as undefined | (() => void) }
}))

vi.mock('../../shared/git-branch-line-total', async (importOriginal) => {
  const actual = await importOriginal<typeof BranchLineTotal>()
  return {
    ...actual,
    computeGitBranchLineTotal: (
      input: Parameters<typeof BranchLineTotal.computeGitBranchLineTotal>[0]
    ) => {
      // The lease is taken synchronously inside, so counting after the call
      // means a join is observable the instant it has happened.
      const total = actual.computeGitBranchLineTotal(input)
      coalescerJoins.count += 1
      coalescerJoins.onJoin?.()
      return total
    }
  }
})

vi.mock('./runner', async (importOriginal) => {
  const actual = await importOriginal<typeof GitRunner>()
  return {
    ...actual,
    gitExecFileAsync: async (...args: Parameters<typeof GitRunner.gitExecFileAsync>) => {
      gitExecCalls.push(args[0])
      await execHooks.beforeExec?.(args[0])
      return actual.gitExecFileAsync(...args)
    },
    gitExecFileAsyncBuffer: async (
      ...args: Parameters<typeof GitRunner.gitExecFileAsyncBuffer>
    ) => {
      gitExecCalls.push(args[0])
      return actual.gitExecFileAsyncBuffer(...args)
    },
    gitStreamStdout: async (...args: Parameters<typeof GitRunner.gitStreamStdout>) => {
      gitExecCalls.push(args[0])
      return actual.gitStreamStdout(...args)
    }
  }
})

import {
  clearEffectiveUpstreamStatusCacheForTests,
  clearSubmodulePathsCacheForTests,
  getStatus,
  invalidateGitReadCaches
} from './status'

const BOGUS_MERGE_BASE = 'deadbeef'.repeat(5)
const tempRoots: string[] = []

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

async function createFixtureRepo(): Promise<{ repo: string; mergeBase: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-branch-line-total-exec-'))
  tempRoots.push(root)
  const repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test User'])
  git(repo, ['config', 'commit.gpgSign', 'false'])
  await write(repo, 'f.txt', 'a\nb\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'base'])
  await write(repo, 'f.txt', 'a\nb\nc\n')
  return { repo, mergeBase: git(repo, ['rev-parse', 'HEAD']) }
}

async function write(repo: string, relativePath: string, contents: string): Promise<void> {
  const target = path.join(repo, relativePath)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, contents)
}

/** The `mergeBase → worktree` diff, distinguished from the per-area numstats by its rev + `--`. */
function rangedDiffCalls(): string[][] {
  return gitExecCalls.filter((args) => args.includes('--numstat') && args.at(-1) === '--')
}

function numstatCalls(): string[][] {
  return gitExecCalls.filter((args) => args.includes('--numstat'))
}

/** Resolves once `count` status passes have entered the branch-total coalescer. */
function waitForCoalescerJoins(count: number): Promise<void> {
  if (coalescerJoins.count >= count) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    coalescerJoins.onJoin = () => {
      if (coalescerJoins.count >= count) {
        coalescerJoins.onJoin = undefined
        resolve()
      }
    }
  })
}

function resetGitReadCaches(): void {
  clearEffectiveUpstreamStatusCacheForTests()
  clearSubmodulePathsCacheForTests()
  invalidateGitReadCaches()
  invalidateGitBranchLineTotalInFlight()
}

beforeEach(() => {
  gitExecCalls.length = 0
  execHooks.beforeExec = undefined
  coalescerJoins.count = 0
  coalescerJoins.onJoin = undefined
  resetGitReadCaches()
})

afterEach(async () => {
  execHooks.beforeExec = undefined
  coalescerJoins.onJoin = undefined
  resetGitReadCaches()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('branch line total completeness', () => {
  it('omits the total when the status listing hit its limit', async () => {
    const { repo, mergeBase } = await createFixtureRepo()
    await write(repo, 'u1.txt', 'a\n')
    await write(repo, 'u2.txt', 'b\n')
    await write(repo, 'u3.txt', 'c\n')

    const result = await getStatus(repo, { branchLineTotalMergeBase: mergeBase, limit: 1 })

    expect(result.didHitLimit).toBe(true)
    expect(result.branchLineTotal).toBeUndefined()
    expect(rangedDiffCalls()).toEqual([])
  })

  it('omits the total when the ranged numstat fails, rather than reporting zero', async () => {
    const { repo } = await createFixtureRepo()

    const result = await getStatus(repo, { branchLineTotalMergeBase: BOGUS_MERGE_BASE })

    expect(result.entries.length).toBeGreaterThan(0)
    expect(result.branchLineTotal).toBeUndefined()
    // The diff really was attempted, so this is a failure path and not a gate.
    expect(rangedDiffCalls()).toHaveLength(1)
  })

  it('omits the total for a directory that is not a git worktree', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orca-branch-line-total-folder-'))
    tempRoots.push(root)

    const result = await getStatus(root, { branchLineTotalMergeBase: BOGUS_MERGE_BASE })

    expect(result.branchLineTotal).toBeUndefined()
    expect(rangedDiffCalls()).toEqual([])
  })

  it('rejects with an AbortError when the pass is cancelled mid-diff', async () => {
    const { repo, mergeBase } = await createFixtureRepo()
    const controller = new AbortController()
    execHooks.beforeExec = (args) => {
      if (args.includes('--numstat') && args.at(-1) === '--') {
        controller.abort()
      }
    }

    await expect(
      getStatus(repo, { branchLineTotalMergeBase: mergeBase, signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    // The pass had already streamed status and reached the ranged diff, so this
    // is a cancellation in flight rather than a pre-flight rejection.
    expect(rangedDiffCalls()).toHaveLength(1)
  })
})

describe('branch line total merge-base gate', () => {
  it('runs no ranged diff and returns no total without a merge base', async () => {
    const { repo } = await createFixtureRepo()

    const result = await getStatus(repo)

    expect(result.branchLineTotal).toBeUndefined()
    expect(rangedDiffCalls()).toEqual([])
  })

  it.each(['--upload-pack=x', 'HEAD', '', 'origin/main', '-M', 'A1B2C3D'])(
    'never spawns a ranged diff for a merge base of %j',
    async (branchLineTotalMergeBase) => {
      const { repo } = await createFixtureRepo()

      const result = await getStatus(repo, { branchLineTotalMergeBase })

      expect(result.branchLineTotal).toBeUndefined()
      expect(rangedDiffCalls()).toEqual([])
      expect(gitExecCalls).not.toContainEqual(
        buildGitBranchLineTotalDiffArgs(branchLineTotalMergeBase)
      )
    }
  )

  it('never leaks a flag-shaped merge base into any git argv', async () => {
    const { repo } = await createFixtureRepo()

    await getStatus(repo, { branchLineTotalMergeBase: '--upload-pack=/tmp/evil' })

    for (const args of gitExecCalls) {
      expect(args).not.toContain('--upload-pack=/tmp/evil')
    }
  })
})

describe('branch line total exec budget', () => {
  it('costs exactly one extra exec versus the same pass with the chip hidden', async () => {
    const { repo, mergeBase } = await createFixtureRepo()

    await getStatus(repo)
    const withoutChip = gitExecCalls.map((args) => args.join(' '))

    gitExecCalls.length = 0
    resetGitReadCaches()
    await getStatus(repo, { branchLineTotalMergeBase: mergeBase })
    const withChip = gitExecCalls.map((args) => args.join(' '))

    expect(withChip.filter((args) => !args.endsWith(`${mergeBase} --`))).toEqual(withoutChip)
    expect(withChip).toHaveLength(withoutChip.length + 1)
  })

  it('shares one ranged diff between two concurrent identical status passes', async () => {
    const { repo, mergeBase } = await createFixtureRepo()

    const [first, second] = await Promise.all([
      getStatus(repo, { branchLineTotalMergeBase: mergeBase }),
      getStatus(repo, { branchLineTotalMergeBase: mergeBase })
    ])

    expect(first.branchLineTotal).toEqual({ added: 1, removed: 0, mergeBase })
    expect(second.branchLineTotal).toEqual(first.branchLineTotal)
    expect(rangedDiffCalls()).toHaveLength(1)
  })

  it('shares one ranged diff across status passes the status lease cannot merge', async () => {
    const { repo, mergeBase } = await createFixtureRepo()
    // Why: `limit` is part of the status read key, so these two passes each run
    // their own `git status`; only the branch-total coalescer can merge the diff.
    // Hold the first diff exactly until the second pass has taken the lease: a
    // fixed sleep would either release too early or, on a slow machine, outrun
    // GIT_BRANCH_LINE_TOTAL_SOFT_DEADLINE_MS and publish without an exact total.
    execHooks.beforeExec = async (args) => {
      if (args.includes('--numstat') && args.at(-1) === '--') {
        await waitForCoalescerJoins(2)
      }
    }

    const [first, second] = await Promise.all([
      getStatus(repo, { branchLineTotalMergeBase: mergeBase, limit: 0 }),
      getStatus(repo, { branchLineTotalMergeBase: mergeBase, limit: 4096 })
    ])

    expect(first.branchLineTotal).toEqual({ added: 1, removed: 0, mergeBase })
    expect(second.branchLineTotal).toEqual(first.branchLineTotal)
    // Proves the saving came from the branch-total coalescer: both passes really
    // ran their own `git status`, so the status lease merged nothing.
    expect(gitExecCalls.filter((args) => args.includes('status'))).toHaveLength(2)
    expect(rangedDiffCalls()).toHaveLength(1)
  })

  it('reuses the cached total when the pass reuses cached line stats', async () => {
    const { repo, mergeBase } = await createFixtureRepo()

    const first = await getStatus(repo, {
      branchLineTotalMergeBase: mergeBase,
      reuseLineStats: true
    })
    expect(rangedDiffCalls()).toHaveLength(1)
    expect(numstatCalls()).toHaveLength(2)

    gitExecCalls.length = 0
    invalidateGitBranchLineTotalInFlight()
    const second = await getStatus(repo, {
      branchLineTotalMergeBase: mergeBase,
      reuseLineStats: true
    })

    expect(second.branchLineTotal).toEqual(first.branchLineTotal)
    expect(second.branchLineTotal).toEqual({ added: 1, removed: 0, mergeBase })
    expect(numstatCalls()).toEqual([])
  })

  it('recomputes rather than reusing a total measured against another merge base', async () => {
    const { repo, mergeBase } = await createFixtureRepo()
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'second'])
    const laterMergeBase = git(repo, ['rev-parse', 'HEAD'])

    await getStatus(repo, { branchLineTotalMergeBase: mergeBase, reuseLineStats: true })
    gitExecCalls.length = 0
    invalidateGitBranchLineTotalInFlight()
    const result = await getStatus(repo, {
      branchLineTotalMergeBase: laterMergeBase,
      reuseLineStats: true
    })

    expect(result.branchLineTotal).toEqual({ added: 0, removed: 0, mergeBase: laterMergeBase })
    expect(rangedDiffCalls()).toHaveLength(1)
  })
})
