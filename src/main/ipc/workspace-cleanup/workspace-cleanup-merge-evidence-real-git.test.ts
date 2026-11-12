// Real Git: squash merges and deleted remote branches are what mocked argv cannot model.
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installRealWorkerThreadChildProcesses } from '../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { removeTree } from '../../../shared/windows-transient-lock-removal'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { getWorkspaceCleanupMergeReasons } from '../../../shared/workspace-cleanup/workspace-cleanup'
import { readWorkspaceCleanupGitEvidence } from './workspace-cleanup-git-evidence'

const execFileAsync = promisify(execFile)

installRealWorkerThreadChildProcesses()

let scratchDir = ''
let clonePath = ''
let worktreePath = ''

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout.trim()
}

async function commitFile(cwd: string, name: string): Promise<void> {
  await writeFile(join(cwd, name), `${name}\n`)
  await git(['add', name], cwd)
  await git(['commit', '-qm', name], cwd)
}

async function readEvidence(baseRef?: string, branch = 'feature') {
  const repo = { id: 'repo', path: clonePath, displayName: 'repo' } as Repo
  const worktree = {
    id: `repo::${worktreePath}`,
    repoId: 'repo',
    path: worktreePath,
    branch: `refs/heads/${branch}`,
    head: await git(['rev-parse', 'HEAD'], worktreePath),
    isMainWorktree: false,
    ...(baseRef ? { baseRef } : {})
  } as Worktree
  const evidence = await readWorkspaceCleanupGitEvidence(
    worktree,
    repo,
    { kind: 'local', hostId: 'local' },
    {}
  )
  return {
    blockers: evidence.blockers,
    merge: evidence.merge,
    reasons: getWorkspaceCleanupMergeReasons(evidence.merge)
  }
}

beforeEach(async () => {
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-cleanup-merge-')))
  const origin = join(scratchDir, 'origin.git')
  const seed = join(scratchDir, 'seed')
  clonePath = join(scratchDir, 'clone')
  worktreePath = join(scratchDir, 'feature')
  await git(['init', '-q', '--bare', '-b', 'main', origin], scratchDir)
  await git(['init', '-q', '-b', 'main', seed], scratchDir)
  await git(['config', 'user.email', 'cleanup@example.invalid'], seed)
  await git(['config', 'user.name', 'Cleanup'], seed)
  await commitFile(seed, 'seed.txt')
  await git(['push', '-q', origin, 'main'], seed)
  await git(['clone', '-q', origin, clonePath], scratchDir)
  await git(['config', 'user.email', 'cleanup@example.invalid'], clonePath)
  await git(['config', 'user.name', 'Cleanup'], clonePath)
  await git(['config', 'maintenance.auto', 'false'], clonePath)
  await git(['config', 'gc.auto', '0'], clonePath)
  await git(
    ['worktree', 'add', '-q', '--no-track', '-b', 'feature', worktreePath, 'origin/main'],
    clonePath
  )
})

afterEach(async () => {
  await removeTree(scratchDir)
})

describe('workspace cleanup merge evidence against real Git', () => {
  it('calls a squash-merged branch whose remote was deleted merged, with no unpushed risk', async () => {
    await commitFile(worktreePath, 'a.txt')
    await commitFile(worktreePath, 'b.txt')
    await git(['push', '-q', '-u', 'origin', 'feature'], worktreePath)
    // Squash on main the way a forge does, then delete the remote branch.
    await git(['merge', '-q', '--squash', 'feature'], clonePath)
    await git(['commit', '-qm', 'squash feature'], clonePath)
    await git(['push', '-q', 'origin', 'main', ':feature'], clonePath)
    await git(['fetch', '-q', '--prune', 'origin'], clonePath)

    expect(await readEvidence()).toEqual({
      blockers: [],
      merge: { headInDefaultBranch: true, aheadOfDefault: 2 },
      reasons: ['merged']
    })
  })

  it('calls a branch with no commits beyond its base unchanged', async () => {
    expect(await readEvidence()).toEqual({
      blockers: [],
      merge: { headInDefaultBranch: true, aheadOfDefault: 0 },
      reasons: ['unchanged']
    })
  })

  it('gives a pushed but unmerged branch neither reason', async () => {
    await commitFile(worktreePath, 'a.txt')
    await git(['push', '-q', '-u', 'origin', 'feature'], worktreePath)

    expect(await readEvidence()).toEqual({
      blockers: [],
      merge: { headInDefaultBranch: false, aheadOfDefault: 1 },
      reasons: []
    })
  })

  it('keeps unpushed risk when the remote branch was deleted without merging', async () => {
    await commitFile(worktreePath, 'a.txt')
    await git(['push', '-q', '-u', 'origin', 'feature'], worktreePath)
    await git(['push', '-q', 'origin', ':feature'], clonePath)
    await git(['fetch', '-q', '--prune', 'origin'], clonePath)

    expect(await readEvidence()).toEqual({
      blockers: ['unpushed-commits'],
      merge: { headInDefaultBranch: false, aheadOfDefault: 1 },
      reasons: []
    })
  })

  it('ignores a base that is the reused branch itself', async () => {
    await commitFile(worktreePath, 'a.txt')

    expect((await readEvidence('feature')).blockers).toEqual(['unpushed-commits'])
  })

  it('ignores a default branch that is the workspace branch itself', async () => {
    await git(['checkout', '-q', '--detach'], clonePath)
    await git(['branch', '-q', '-m', 'main', 'old-main'], clonePath)
    await git(['update-ref', '-d', 'refs/remotes/origin/HEAD'], clonePath)
    await git(['update-ref', '-d', 'refs/remotes/origin/main'], clonePath)
    await git(['branch', '-q', '-m', 'feature', 'main'], worktreePath)
    await commitFile(worktreePath, 'a.txt')

    expect((await readEvidence(undefined, 'main')).blockers).toEqual(['unpushed-commits'])
  })

  it('keeps unpushed risk for local commits that never landed', async () => {
    await commitFile(worktreePath, 'a.txt')

    expect(await readEvidence()).toEqual({
      blockers: ['unpushed-commits'],
      merge: { headInDefaultBranch: false, aheadOfDefault: 1 },
      reasons: []
    })
  })
})
