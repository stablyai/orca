// Real-binary parity: the membership model's file rows must equal `git worktree list` row for row,
// or a worktree's id (`repoId::path`) would change under it.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { removeTree } from '../../../shared/windows-transient-lock-removal'
import { clearGitCapabilityStateForTests } from '../git-capability-state'
import { listWorktreesStrict } from '../worktree-listing'
import { areWorktreePathsEqual } from '../worktree-path-comparison'
import {
  _getWorktreeMembershipModelForTests,
  _resetWorktreeMembershipModelsForTests,
  readWorktreeMembership
} from './worktree-membership-store'
import { MEMBERSHIP_REUSE_WINDOW_MS } from './worktree-membership-model'

const execFileAsync = promisify(execFile)

let scratchDir = ''
let repoPath = ''
let now = 0

/** Past the reuse window, so the next read re-validates by stat with no mark. */
function readAfterReuseWindow(path: string): ReturnType<typeof readWorktreeMembership> {
  now += MEMBERSHIP_REUSE_WINDOW_MS
  return readWorktreeMembership(path)
}

async function git(args: string[], cwd = repoPath): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

async function gitVersionAtLeast(major: number, minor: number): Promise<boolean> {
  const match = (await git(['--version'], scratchDir)).match(/(\d+)\.(\d+)/)
  const [actualMajor, actualMinor] = [Number(match?.[1]), Number(match?.[2])]
  return actualMajor > major || (actualMajor === major && actualMinor >= minor)
}

// The reason text is Git's localized prose; Orca reads only the flag.
function comparable(rows: GitWorktreeInfo[]): GitWorktreeInfo[] {
  return rows.map(({ prunableReason: _reason, ...row }) => row)
}

async function expectFileRowsMatchGit(): Promise<GitWorktreeInfo[]> {
  const fromGit = await listWorktreesStrict(repoPath, { includeCreatePreparations: true })
  const { rows } = await readAfterReuseWindow(repoPath)
  expect(comparable(rows)).toEqual(comparable(fromGit))
  expect(_getWorktreeMembershipModelForTests(repoPath)?.source).toEqual({ kind: 'files' })
  return rows
}

beforeEach(async () => {
  // realpath: macOS hands out /var/... temp paths while Git reports /private/var/...
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-membership-')))
  repoPath = join(scratchDir, 'repo')
  await mkdir(repoPath, { recursive: true })
  await git(['init', '-q', '-b', 'main'])
  await git(['config', 'user.email', 'membership@example.invalid'])
  await git(['config', 'user.name', 'Membership'])
  await writeFile(join(repoPath, 'seed.txt'), 'seed\n')
  await git(['add', '-A'])
  await git(['commit', '-qm', 'seed'])
  _resetWorktreeMembershipModelsForTests()
  now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})

afterEach(async () => {
  vi.restoreAllMocks()
  _resetWorktreeMembershipModelsForTests()
  clearGitCapabilityStateForTests()
  await removeTree(scratchDir)
})

describe('worktree membership model against the real Git binary', () => {
  it('matches git worktree list for every worktree state it derives from files', async () => {
    const wt = (name: string): string => join(scratchDir, 'workspaces', name)
    await git(['worktree', 'add', '-q', wt('on-branch'), '-b', 'feature'])
    await git(['worktree', 'add', '-q', '--detach', wt('detached')])
    await git(['worktree', 'add', '-q', wt('unborn'), '-b', 'will-be-unborn'])
    await git(['symbolic-ref', 'HEAD', 'refs/heads/never-committed'], wt('unborn'))
    await git(['worktree', 'add', '-q', wt('locked'), '-b', 'locked-branch'])
    await git(['worktree', 'lock', '--reason', 'kept for a demo', wt('locked')])
    await git(['worktree', 'add', '-q', wt('with space'), '-b', 'spaced'])
    await git(['worktree', 'add', '-q', wt('packed'), '-b', 'packed-only'])
    await git(['worktree', 'add', '-q', '-f', wt('shared'), 'feature'])
    await git(['worktree', 'add', '-q', wt('sparse'), '-b', 'sparse-branch'])
    await git(['sparse-checkout', 'set', 'nothing-here'], wt('sparse'))
    await git(['worktree', 'add', '-q', wt('gone'), '-b', 'gone-branch'])
    await removeTree(wt('gone'))
    await git(['pack-refs', '--all'])

    const rows = await expectFileRowsMatchGit()
    // Git for Windows spells rows with `/`; `join` spells the expectation with `\`.
    const row = (name: string) => rows.find((entry) => areWorktreePathsEqual(entry.path, wt(name)))
    expect(row('sparse')?.isSparse).toBe(true)
    expect(row('gone')?.prunable).toBe(true)
    expect(row('unborn')?.branch).toBe('refs/heads/never-committed')
  })

  it('reports a missing linked HEAD the way Git does', async () => {
    const linked = join(scratchDir, 'workspaces', 'no-head')
    await git(['worktree', 'add', '-q', linked, '-b', 'no-head'])
    await rm(join(repoPath, '.git', 'worktrees', 'no-head', 'HEAD'))
    await expectFileRowsMatchGit()
  })

  it('sees changes that no watcher reported, by stat, without re-listing', async () => {
    const first = join(scratchDir, 'workspaces', 'first')
    const second = join(scratchDir, 'workspaces', 'second')
    await git(['worktree', 'add', '-q', first, '-b', 'first'])
    await expectFileRowsMatchGit()

    // A commit, a sibling's update-ref, an external add, a lock, and an external remove.
    await writeFile(join(first, 'change.txt'), 'change\n')
    await git(['add', '-A'], first)
    await git(['commit', '-qm', 'change'], first)
    await expectFileRowsMatchGit()
    await git(['update-ref', 'refs/heads/first', 'main'], repoPath)
    await expectFileRowsMatchGit()
    await git(['worktree', 'add', '-q', second, '-b', 'second'])
    await expectFileRowsMatchGit()
    await git(['worktree', 'lock', second])
    await expectFileRowsMatchGit()
    await git(['worktree', 'unlock', second])
    await git(['worktree', 'remove', second])
    await expectFileRowsMatchGit()
  })

  it('uses Git for relative gitdir records and still answers exactly', async () => {
    if (!(await gitVersionAtLeast(2, 48))) {
      return
    }
    const linked = join(scratchDir, 'workspaces', 'relative')
    await git(['worktree', 'add', '-q', '--relative-paths', linked, '-b', 'relative'])
    const fromGit = await listWorktreesStrict(repoPath, { includeCreatePreparations: true })
    const { rows } = await readWorktreeMembership(repoPath)
    expect(comparable(rows)).toEqual(comparable(fromGit))
    expect(_getWorktreeMembershipModelForTests(repoPath)?.source).toEqual({
      kind: 'git',
      reason: 'relative gitdir'
    })
  })

  it('uses Git for a reftable repo', async () => {
    if (!(await gitVersionAtLeast(2, 45))) {
      return
    }
    const reftableRepo = join(scratchDir, 'reftable')
    await mkdir(reftableRepo)
    await git(['init', '-q', '--ref-format=reftable', '-b', 'main'], reftableRepo)
    await git(
      [
        '-c',
        'user.email=r@example.invalid',
        '-c',
        'user.name=R',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'seed'
      ],
      reftableRepo
    )
    await git(['worktree', 'add', '-q', join(scratchDir, 'reftable-wt'), '-b', 'wt'], reftableRepo)
    const fromGit = await listWorktreesStrict(reftableRepo, { includeCreatePreparations: true })
    const { rows } = await readWorktreeMembership(reftableRepo)
    expect(rows).toEqual(fromGit)
    expect(_getWorktreeMembershipModelForTests(reftableRepo)?.source).toEqual({
      kind: 'git',
      reason: 'ref storage reftable'
    })
  })

  it('derives a bare repo with linked worktrees from files, main row from Git', async () => {
    const bare = join(scratchDir, 'bare.git')
    await git(['clone', '-q', '--bare', repoPath, bare], scratchDir)
    await git(['worktree', 'add', '-q', join(scratchDir, 'bare-wt'), 'main'], bare)
    const fromGit = await listWorktreesStrict(bare, { includeCreatePreparations: true })
    const { rows } = await readAfterReuseWindow(bare)
    expect(comparable(rows)).toEqual(comparable(fromGit))
    expect(rows[0]?.isBare).toBe(true)
    expect(_getWorktreeMembershipModelForTests(bare)?.source).toEqual({ kind: 'files' })
  })
})
