/**
 * Relay-side contract for the status pass's branch line total: the chip is an
 * exact number or absent, and costs nothing when nobody asked for it.
 */
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invalidateGitBranchLineTotalInFlight } from '../shared/git-branch-line-total'
import { clearGitStatusLineStatsCache } from '../shared/git-status-line-stats-cache'
import type { GitExec } from './git-handler-ops'
import { getStatusOp } from './git-handler-status-ops'
import type { RelayGitStreamExec } from './git-stdout-stream'
import { clearNoEffectiveUpstreamStatusCache } from './git-status-upstream-negative-cache'

type GitCall = Parameters<GitExec>

const execFileAsync = promisify(execFile)
const MERGE_BASE = '0123456789abcdef0123456789abcdef01234567'
const OTHER_MERGE_BASE = 'fedcba9876543210fedcba9876543210fedcba98'
// Untracked additions ride on top of the ranged diff, so the fixture needs a real file.
const UNTRACKED_FILE = 'notes.md'
const UNTRACKED_LINES = 4
const STATUS_OUTPUT = [
  '# branch.oid 1111111111111111111111111111111111111111',
  '# branch.head (detached)',
  '1 .M N... 100644 100644 100644 aaaa aaaa src/a.ts',
  `? ${UNTRACKED_FILE}`
].join('\n')

function isRangedNumstat(args: string[]): boolean {
  return args.includes('diff') && args.includes('--numstat') && args.includes('-z')
}

function rangedDiffCalls(calls: readonly GitCall[]): string[][] {
  return calls.map(([args]) => args).filter((args) => isRangedNumstat(args))
}

function streamGitFromCapture(git: GitExec): RelayGitStreamExec {
  return async (args, cwd, options) => {
    const { stdout } = await git(args, cwd, {
      disableOptionalLocks: options.disableOptionalLocks,
      signal: options.signal
    })
    return { stoppedEarly: options.onStdout(stdout) === true }
  }
}

/** Mock host; the fixture-repo cases below run real git instead. */
function createMockGit(overrides: {
  status?: string
  ranged?: () => Promise<{ stdout: string; stderr: string }>
  areaNumstat?: string
}) {
  return vi.fn<GitExec>(async (args) => {
    if (args.includes('status')) {
      return { stdout: overrides.status ?? STATUS_OUTPUT, stderr: '' }
    }
    if (isRangedNumstat(args)) {
      return overrides.ranged ? overrides.ranged() : { stdout: '12\t5\tsrc/a.ts\n', stderr: '' }
    }
    if (args.includes('diff')) {
      return { stdout: overrides.areaNumstat ?? '3\t2\tsrc/a.ts\n', stderr: '' }
    }
    throw new Error(`Unexpected git command: ${args.join(' ')}`)
  })
}

const realGitExec: GitExec = async (args, cwd, opts) => {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    ...(opts?.signal ? { signal: opts.signal } : {}),
    ...(opts?.timeout ? { timeout: opts.timeout } : {})
  })
  return { stdout, stderr }
}

function runFixtureGit(repo: string, args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.email=test@test.com',
      '-c',
      'user.name=Test',
      '-c',
      'commit.gpgSign=false',
      ...args
    ],
    { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim()
}

/**
 * Fork point → working tree: +3 tracked (2 committed, 1 unstaged), -2 from the
 * file the branch deleted, +4 untracked. The pure rename contributes nothing.
 */
async function seedBranchFixture(repo: string): Promise<string> {
  await fs.rm(path.join(repo, UNTRACKED_FILE), { force: true })
  execFileSync('git', ['init', '-q', repo], { stdio: 'pipe' })
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'a\nb\nc\n')
  await fs.writeFile(path.join(repo, 'doomed.txt'), 'x\ny\n')
  await fs.writeFile(path.join(repo, 'old-name.txt'), 'stable\n')
  runFixtureGit(repo, ['add', '.'])
  runFixtureGit(repo, ['commit', '-m', 'base'])
  const mergeBase = runFixtureGit(repo, ['rev-parse', 'HEAD'])

  runFixtureGit(repo, ['checkout', '-q', '-b', 'feature'])
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'a\nb\nc\nd\ne\n')
  await fs.rm(path.join(repo, 'doomed.txt'))
  runFixtureGit(repo, ['add', '-A'])
  runFixtureGit(repo, ['commit', '-m', 'branch commit'])

  runFixtureGit(repo, ['mv', 'old-name.txt', 'new-name.txt'])
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'a\nb\nc\nd\ne\nf\n')
  await fs.writeFile(path.join(repo, UNTRACKED_FILE), 'n1\nn2\nn3\nn4\n')
  return mergeBase
}

describe('getStatusOp branch line total', () => {
  let tmpDir: string

  beforeEach(async () => {
    clearNoEffectiveUpstreamStatusCache()
    clearGitStatusLineStatsCache()
    invalidateGitBranchLineTotalInFlight()
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-branch-line-total-'))
    await fs.writeFile(path.join(tmpDir, UNTRACKED_FILE), 'n1\nn2\nn3\nn4\n')
  })

  afterEach(async () => {
    clearNoEffectiveUpstreamStatusCache()
    clearGitStatusLineStatsCache()
    invalidateGitBranchLineTotalInFlight()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('runs no ranged diff and returns no total when the merge base param is absent', async () => {
    const git = createMockGit({})

    const result = await getStatusOp(git, streamGitFromCapture(git), { worktreePath: tmpDir })

    expect(rangedDiffCalls(git.mock.calls)).toEqual([])
    expect(Object.hasOwn(result, 'branchLineTotal')).toBe(false)
    expect(result.branchLineTotal).toBeUndefined()
    // The per-area numstats the CHANGES rows need still ran, so this is a
    // zero-cost omission rather than a disabled status pass.
    expect(result.entries).toContainEqual(
      expect.objectContaining({ path: 'src/a.ts', added: 3, removed: 2 })
    )
  })

  it('sums the ranged diff and untracked additions against a real fixture repo', async () => {
    const mergeBase = await seedBranchFixture(tmpDir)
    const git = vi.fn<GitExec>(realGitExec)

    const result = await getStatusOp(git, streamGitFromCapture(git), {
      worktreePath: tmpDir,
      branchLineTotalMergeBase: mergeBase
    })

    expect(result.branchLineTotal).toEqual({
      added: 3 + UNTRACKED_LINES,
      removed: 2,
      mergeBase
    })
    expect(rangedDiffCalls(git.mock.calls)).toEqual([
      ['-c', 'core.quotePath=false', 'diff', '-z', '--numstat', '-M', mergeBase, '--']
    ])
  })

  it('omits the total when the status listing hit its limit', async () => {
    const manyEntries = Array.from(
      { length: 6 },
      (_, index) => `1 A. N... 100644 100644 100644 000000 111111 generated-${index}.txt`
    ).join('\n')
    const git = createMockGit({ status: manyEntries })

    const result = await getStatusOp(git, streamGitFromCapture(git), {
      worktreePath: tmpDir,
      limit: 3,
      branchLineTotalMergeBase: MERGE_BASE
    })

    expect(result.didHitLimit).toBe(true)
    // The untracked list is truncated, so any total would silently under-count.
    expect(Object.hasOwn(result, 'branchLineTotal')).toBe(false)
    expect(rangedDiffCalls(git.mock.calls)).toEqual([])
  })

  it('omits the total, never zero, when the ranged diff fails', async () => {
    const git = createMockGit({
      ranged: () => Promise.reject(new Error('fatal: bad object 0123456789abcdef'))
    })

    const result = await getStatusOp(git, streamGitFromCapture(git), {
      worktreePath: tmpDir,
      branchLineTotalMergeBase: MERGE_BASE
    })

    expect(Object.hasOwn(result, 'branchLineTotal')).toBe(false)
    expect(result.branchLineTotal).toBeUndefined()
    expect(rangedDiffCalls(git.mock.calls)).toHaveLength(1)
    // A failed ranged diff must not take the per-file rows down with it.
    expect(result.entries).toContainEqual(expect.objectContaining({ path: 'src/a.ts', added: 3 }))
  })

  it('omits the total, never zero, for a well-formed but unknown merge-base oid', async () => {
    await seedBranchFixture(tmpDir)
    const git = vi.fn<GitExec>(realGitExec)

    const result = await getStatusOp(git, streamGitFromCapture(git), {
      worktreePath: tmpDir,
      branchLineTotalMergeBase: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    })

    expect(rangedDiffCalls(git.mock.calls)).toHaveLength(1)
    expect(Object.hasOwn(result, 'branchLineTotal')).toBe(false)
    expect(result.entries.length).toBeGreaterThan(0)
  })

  it('omits the total when the ranged diff exceeds its time budget', async () => {
    const git = createMockGit({
      ranged: () => {
        const error: Error & { killed?: boolean } = new Error('spawn git ETIMEDOUT')
        error.killed = true
        return Promise.reject(error)
      }
    })

    const result = await getStatusOp(git, streamGitFromCapture(git), {
      worktreePath: tmpDir,
      branchLineTotalMergeBase: MERGE_BASE
    })

    expect(Object.hasOwn(result, 'branchLineTotal')).toBe(false)
    expect(rangedDiffCalls(git.mock.calls)).toHaveLength(1)
    // The budget is handed to the subprocess rather than raced on a wall clock.
    const rangedOptions = git.mock.calls.find(([args]) => isRangedNumstat(args))?.[2]
    expect(rangedOptions).toMatchObject({ disableOptionalLocks: true, timeout: expect.any(Number) })
  })

  it('omits the total when the status scan itself failed', async () => {
    const git = vi.fn<GitExec>(async (args) => {
      if (args.includes('status')) {
        throw new Error('fatal: not a git repository')
      }
      throw new Error(`Unexpected git command: ${args.join(' ')}`)
    })

    const result = await getStatusOp(git, streamGitFromCapture(git), {
      worktreePath: tmpDir,
      branchLineTotalMergeBase: MERGE_BASE
    })

    expect(result.entries).toEqual([])
    // A failed scan yields an empty untracked list, which would read as "no
    // untracked additions" rather than "unknown".
    expect(Object.hasOwn(result, 'branchLineTotal')).toBe(false)
    expect(rangedDiffCalls(git.mock.calls)).toEqual([])
  })

  // Relay params are an untyped bag, so the merge base must be proven to be an
  // object name before it can be spliced into an argv.
  it.each([
    ['a flag-shaped value', '--upload-pack=x'],
    ['a rev name', 'HEAD'],
    ['a ref path', 'refs/heads/main'],
    ['a range', `${MERGE_BASE}..HEAD`],
    ['a number', 123],
    ['null', null],
    ['an empty string', '']
  ])('rejects %s before it reaches a git argv', async (_label, value) => {
    const git = createMockGit({})

    const result = await getStatusOp(git, streamGitFromCapture(git), {
      worktreePath: tmpDir,
      branchLineTotalMergeBase: value
    })

    expect(Object.hasOwn(result, 'branchLineTotal')).toBe(false)
    expect(rangedDiffCalls(git.mock.calls)).toEqual([])
    for (const [args] of git.mock.calls) {
      expect(args).not.toContain(String(value))
    }
  })

  it('answers a rejected merge base with the byte-identical no-merge-base response', async () => {
    const gitWithout = createMockGit({})
    const withoutParam = await getStatusOp(gitWithout, streamGitFromCapture(gitWithout), {
      worktreePath: tmpDir
    })
    clearGitStatusLineStatsCache()
    const gitRejected = createMockGit({})
    const rejectedParam = await getStatusOp(gitRejected, streamGitFromCapture(gitRejected), {
      worktreePath: tmpDir,
      branchLineTotalMergeBase: '--upload-pack=x'
    })

    expect(JSON.stringify(rejectedParam)).toBe(JSON.stringify(withoutParam))
    expect(gitRejected.mock.calls.map(([args]) => args)).toEqual(
      gitWithout.mock.calls.map(([args]) => args)
    )
  })

  it('rejects an aborted scan instead of resolving a partial total', async () => {
    const controller = new AbortController()
    const git = vi.fn<GitExec>(async (args) => {
      if (args.includes('status')) {
        return { stdout: STATUS_OUTPUT, stderr: '' }
      }
      if (isRangedNumstat(args)) {
        controller.abort()
        const error = new Error('The operation was aborted.')
        error.name = 'AbortError'
        throw error
      }
      if (args.includes('diff')) {
        return { stdout: '3\t2\tsrc/a.ts\n', stderr: '' }
      }
      throw new Error(`Unexpected git command: ${args.join(' ')}`)
    })

    await expect(
      getStatusOp(
        git,
        streamGitFromCapture(git),
        { worktreePath: tmpDir, branchLineTotalMergeBase: MERGE_BASE },
        { signal: controller.signal }
      )
    ).rejects.toThrow(/abort/i)
    expect(rangedDiffCalls(git.mock.calls)).toHaveLength(1)
  })

  it('reuses the cached total instead of re-running the ranged diff', async () => {
    const git = createMockGit({})

    const first = await getStatusOp(git, streamGitFromCapture(git), {
      worktreePath: tmpDir,
      branchLineTotalMergeBase: MERGE_BASE
    })
    const reused = await getStatusOp(git, streamGitFromCapture(git), {
      worktreePath: tmpDir,
      branchLineTotalMergeBase: MERGE_BASE,
      reuseLineStats: true
    })

    expect(first.branchLineTotal).toEqual({
      added: 12 + UNTRACKED_LINES,
      removed: 5,
      mergeBase: MERGE_BASE
    })
    expect(reused.branchLineTotal).toEqual(first.branchLineTotal)
    expect(rangedDiffCalls(git.mock.calls)).toHaveLength(1)
  })

  it('coalesces concurrent status passes onto one ranged diff', async () => {
    // The renderer's own in-flight refs only dedupe one renderer; a second
    // window or an fs-watcher burst must not run the ranged diff twice.
    const git = vi.fn<GitExec>(async (args) => {
      if (args.includes('status')) {
        return { stdout: STATUS_OUTPUT, stderr: '' }
      }
      if (isRangedNumstat(args)) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return { stdout: '12\t5\tsrc/a.ts\n', stderr: '' }
      }
      if (args.includes('diff')) {
        return { stdout: '3\t2\tsrc/a.ts\n', stderr: '' }
      }
      throw new Error(`Unexpected git command: ${args.join(' ')}`)
    })

    const [first, second] = await Promise.all([
      getStatusOp(git, streamGitFromCapture(git), {
        worktreePath: tmpDir,
        branchLineTotalMergeBase: MERGE_BASE
      }),
      getStatusOp(git, streamGitFromCapture(git), {
        worktreePath: tmpDir,
        branchLineTotalMergeBase: MERGE_BASE
      })
    ])

    expect(rangedDiffCalls(git.mock.calls)).toHaveLength(1)
    expect(first.branchLineTotal).toEqual(second.branchLineTotal)
    expect(first.branchLineTotal).toEqual({
      added: 12 + UNTRACKED_LINES,
      removed: 5,
      mergeBase: MERGE_BASE
    })
  })

  it('recomputes rather than reusing a total measured against another fork point', async () => {
    const git = createMockGit({})

    await getStatusOp(git, streamGitFromCapture(git), {
      worktreePath: tmpDir,
      branchLineTotalMergeBase: MERGE_BASE
    })
    const moved = await getStatusOp(git, streamGitFromCapture(git), {
      worktreePath: tmpDir,
      branchLineTotalMergeBase: OTHER_MERGE_BASE,
      reuseLineStats: true
    })

    expect(moved.branchLineTotal).toEqual({
      added: 12 + UNTRACKED_LINES,
      removed: 5,
      mergeBase: OTHER_MERGE_BASE
    })
    expect(rangedDiffCalls(git.mock.calls)).toHaveLength(2)
  })

  // Rule 1 of docs/reference/remote-wire-compatibility.md: a new optional field
  // is safe only while every reader survives its absence.
  describe('wire compatibility', () => {
    it('drops the key from the wire payload so a reader sees undefined, not 0 or NaN', async () => {
      const git = createMockGit({ ranged: () => Promise.reject(new Error('fatal: bad object')) })

      const result = await getStatusOp(git, streamGitFromCapture(git), {
        worktreePath: tmpDir,
        branchLineTotalMergeBase: MERGE_BASE
      })
      // An old server's payload and a new server's "not known exact" payload are
      // the same thing on the wire: no key at all.
      const overTheWire = JSON.parse(JSON.stringify(result)) as {
        branchLineTotal?: { added: number; removed: number }
      }

      expect(Object.hasOwn(overTheWire, 'branchLineTotal')).toBe(false)
      expect(overTheWire.branchLineTotal).toBeUndefined()
      expect(overTheWire.branchLineTotal?.added).toBeUndefined()
      expect(overTheWire.branchLineTotal?.removed).toBeUndefined()
    })

    it('keeps the new request param out of the status argv an old server would run', async () => {
      const git = createMockGit({})

      await getStatusOp(git, streamGitFromCapture(git), {
        worktreePath: tmpDir,
        branchLineTotalMergeBase: MERGE_BASE
      })

      const statusArgs = git.mock.calls
        .map(([args]) => args)
        .filter((args) => args.includes('status'))
      expect(statusArgs).toHaveLength(1)
      expect(statusArgs[0]).not.toContain(MERGE_BASE)
    })

    it('publishes finite counts when the ranged diff reports only binaries', async () => {
      const git = createMockGit({
        ranged: () => Promise.resolve({ stdout: '-\t-\tlogo.png\n', stderr: '' })
      })

      const result = await getStatusOp(git, streamGitFromCapture(git), {
        worktreePath: tmpDir,
        branchLineTotalMergeBase: MERGE_BASE
      })

      expect(result.branchLineTotal).toEqual({
        added: UNTRACKED_LINES,
        removed: 0,
        mergeBase: MERGE_BASE
      })
      expect(Number.isFinite(result.branchLineTotal?.added)).toBe(true)
      expect(Number.isFinite(result.branchLineTotal?.removed)).toBe(true)
    })
  })
})
