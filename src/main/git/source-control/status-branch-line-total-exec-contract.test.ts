import type * as GitExecFileModule from '../command-runner/git-exec-file'
import type * as GitStreamStdoutModule from '../command-runner/git-stream-stdout'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invalidateGitBranchLineTotalInFlight } from '../../../shared/git/status/git-branch-line-total'

import type * as BranchLineTotal from '../../../shared/git/status/git-branch-line-total'

// Spy on real Git argv to validate opt-in and coalescing without stubbing results.
const { gitExecCalls, execHooks, coalescerJoins } = vi.hoisted(() => ({
  gitExecCalls: [] as string[][],
  execHooks: { beforeExec: undefined as undefined | ((args: string[]) => Promise<void> | void) },
  coalescerJoins: { count: 0, onJoin: undefined as undefined | (() => void) }
}))

vi.mock('../../../shared/git/status/git-branch-line-total', async (importOriginal) => {
  const actual = await importOriginal<typeof BranchLineTotal>()
  return {
    ...actual,
    computeGitBranchLineTotal: (
      input: Parameters<typeof BranchLineTotal.computeGitBranchLineTotal>[0]
    ) => {
      // Lease acquisition is synchronous, so a join is observable immediately after this call.
      const total = actual.computeGitBranchLineTotal(input)
      coalescerJoins.count += 1
      coalescerJoins.onJoin?.()
      return total
    }
  }
})

vi.mock('../command-runner/git-exec-file', async (importOriginal) => {
  const actual = await importOriginal<typeof GitExecFileModule>()
  return {
    ...actual,
    gitExecFileAsync: async (...args: Parameters<typeof actual.gitExecFileAsync>) => {
      gitExecCalls.push(args[0])
      await execHooks.beforeExec?.(args[0])
      return actual.gitExecFileAsync(...args)
    },
    gitExecFileAsyncBuffer: async (...args: Parameters<typeof actual.gitExecFileAsyncBuffer>) => {
      gitExecCalls.push(args[0])
      return actual.gitExecFileAsyncBuffer(...args)
    }
  }
})

vi.mock('../command-runner/git-stream-stdout', async (importOriginal) => {
  const actual = await importOriginal<typeof GitStreamStdoutModule>()
  return {
    ...actual,
    gitStreamStdout: async (...args: Parameters<typeof actual.gitStreamStdout>) => {
      gitExecCalls.push(args[0])
      return actual.gitStreamStdout(...args)
    }
  }
})

import { clearEffectiveUpstreamStatusCacheForTests } from './effective-upstream-status-cache'
import { clearSubmodulePathsCacheForTests } from './submodule-paths'
import { getStatus } from './status-read'
import { invalidateGitReadCaches } from './git-read-cache-invalidation'

const BOGUS_MERGE_BASE = 'deadbeef'.repeat(5)
const NO_LINES = { added: 0, removed: 0 }
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
    expect(result.branchLineTotalUnavailable).toBeUndefined()
    expect(rangedDiffCalls()).toEqual([])
  })

  it('invalidates the total when the ranged numstat fails, rather than reporting zero', async () => {
    const { repo } = await createFixtureRepo()

    const result = await getStatus(repo, { branchLineTotalMergeBase: BOGUS_MERGE_BASE })

    expect(result.entries.length).toBeGreaterThan(0)
    expect(result.branchLineTotal).toBeUndefined()
    expect(result.branchLineTotalUnavailable).toBe(BOGUS_MERGE_BASE)
    expect(rangedDiffCalls()).toHaveLength(1)
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
    expect(rangedDiffCalls()).toHaveLength(1)
  })
})

describe('branch line total merge-base gate', () => {
  it('never leaks a flag-shaped merge base into any git argv', async () => {
    const { repo } = await createFixtureRepo()

    await getStatus(repo, { branchLineTotalMergeBase: '--upload-pack=/tmp/evil' })

    for (const args of gitExecCalls) {
      expect(args).not.toContain('--upload-pack=/tmp/evil')
    }
  })
})

describe('branch line total exec budget', () => {
  it('shares one ranged diff across status passes the status lease cannot merge', async () => {
    const { repo, mergeBase } = await createFixtureRepo()
    // Different limits require separate status leases; hold the diff until both join its shared lease.
    execHooks.beforeExec = async (args) => {
      if (args.includes('--numstat') && args.at(-1) === '--') {
        await waitForCoalescerJoins(2)
      }
    }

    const [first, second] = await Promise.all([
      getStatus(repo, { branchLineTotalMergeBase: mergeBase, limit: 0 }),
      getStatus(repo, { branchLineTotalMergeBase: mergeBase, limit: 4096 })
    ])

    expect(first.branchLineTotal).toEqual({
      added: 1,
      removed: 0,
      mergeBase,
      test: NO_LINES,
      generated: NO_LINES
    })
    expect(second.branchLineTotal).toEqual(first.branchLineTotal)
    expect(gitExecCalls.filter((args) => args.includes('status'))).toHaveLength(2)
    expect(rangedDiffCalls()).toHaveLength(1)
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

    expect(result.branchLineTotal).toEqual({
      added: 0,
      removed: 0,
      mergeBase: laterMergeBase,
      test: NO_LINES,
      generated: NO_LINES
    })
    expect(rangedDiffCalls()).toHaveLength(1)
  })
})
