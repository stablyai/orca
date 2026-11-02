// Issue #26344: a worktree created from a remote-only branch tracks that remote branch.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { gitExecFileAsync } from './runner'
import { addWorktree } from './worktree'
import { getBranchConflictKind } from './repo-branch-conflict'
import { finalizePreparedWorktree } from './worktree-create-preparation'
import {
  _resetPreparationPoolForTests,
  listPreparations,
  startPreparation,
  takePreparation
} from '../worktree-create-preparation-pool'

const roots: string[] = []
afterEach(async () => {
  await _resetPreparationPoolForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const commitArgs = [
  '-c',
  'user.name=Test',
  '-c',
  'user.email=test@example.com',
  '-c',
  'commit.gpgSign=false'
]

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await gitExecFileAsync(args, { cwd })).stdout.trim()
}

async function upstreamOf(cwd: string, branch: string): Promise<string | null> {
  try {
    return await git(
      cwd,
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      `${branch}@{upstream}`
    )
  } catch {
    return null
  }
}

/** A clone whose `origin` and `upstream` both carry `alex/fix`, with no local `alex/fix`. */
async function cloneWithRemoteOnlyBranch(): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-remote-branch-upstream-'))
  roots.push(root)
  const seed = join(root, 'seed')
  await gitExecFileAsync(['init', '--quiet', seed], { cwd: root })
  await git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  await writeFile(join(seed, 'file.txt'), 'main\n')
  await git(seed, 'add', '.')
  await git(seed, ...commitArgs, 'commit', '-qm', 'main')
  await git(seed, 'checkout', '-q', '-b', 'alex/fix')
  await writeFile(join(seed, 'file.txt'), 'fix\n')
  await git(seed, ...commitArgs, 'commit', '-qam', 'fix')
  await git(seed, 'checkout', '-q', 'main')
  for (const name of ['origin.git', 'upstream.git']) {
    await gitExecFileAsync(['clone', '--quiet', '--bare', seed, join(root, name)], { cwd: root })
  }
  const repo = join(root, 'repo')
  await gitExecFileAsync(['clone', '--quiet', join(root, 'origin.git'), repo], { cwd: root })
  await git(repo, 'remote', 'add', 'upstream', join(root, 'upstream.git'))
  await git(repo, 'fetch', '--quiet', 'upstream')
  return { root, repo }
}

it('tracks the remote branch it was created from, and nothing else', async () => {
  const { root, repo } = await cloneWithRemoteOnlyBranch()

  // Picking `origin/alex/fix` is not a collision even though `upstream/alex/fix` exists.
  await expect(getBranchConflictKind(repo, 'alex/fix', 'origin/alex/fix')).resolves.toBeNull()

  const fixPath = join(root, 'fix')
  await addWorktree(repo, fixPath, 'alex/fix', 'origin/alex/fix')
  expect(await upstreamOf(fixPath, 'alex/fix')).toBe('origin/alex/fix')
  expect(await git(fixPath, 'rev-parse', 'HEAD')).toBe(
    await git(repo, 'rev-parse', 'refs/remotes/origin/alex/fix')
  )

  // A new branch off a differently named base keeps the untracked default.
  const otherPath = join(root, 'other')
  await addWorktree(repo, otherPath, 'feature/new', 'origin/main')
  expect(await upstreamOf(otherPath, 'feature/new')).toBeNull()
})

it('tracks the remote branch when a prepared checkout finalizes the create', async () => {
  const { root, repo } = await cloneWithRemoteOnlyBranch()
  await startPreparation({
    repoPath: repo,
    workspaceRoot: root,
    baseBranch: 'origin/alex/fix',
    canonicalBase: 'refs/remotes/origin/alex/fix',
    options: {}
  })
  const [prepared] = listPreparations()
  expect(prepared).toBeDefined()
  takePreparation(prepared)

  const fixPath = join(root, 'warm')
  await finalizePreparedWorktree(
    repo,
    prepared.preparedPath,
    fixPath,
    'alex/fix',
    'origin/alex/fix',
    false,
    {},
    prepared.lockReason
  )
  expect(await upstreamOf(fixPath, 'alex/fix')).toBe('origin/alex/fix')
})
