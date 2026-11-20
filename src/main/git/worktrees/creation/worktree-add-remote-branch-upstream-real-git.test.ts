import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { addWorktree } from './worktree-add'
import { getBranchConflictKind } from '../../refs/resolution/repo-branch-conflict'
import './worktree-create-preparation'
import { _resetPreparationPoolForTests } from '../../../workspaces/creation/preparation/worktree-create-preparation-pool'

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

  await expect(getBranchConflictKind(repo, 'alex/fix', 'origin/alex/fix')).resolves.toBeNull()

  const fixPath = join(root, 'fix')
  await addWorktree(repo, fixPath, 'alex/fix', 'origin/alex/fix')
  expect(await upstreamOf(fixPath, 'alex/fix')).toBe('origin/alex/fix')
  const ref = 'refs/remotes/origin/alex/fix'
  expect(await git(fixPath, 'config', '--get', 'branch.alex/fix.base')).toBe(ref)
  expect(await git(fixPath, 'config', '--get', 'push.autoSetupRemote')).toBe('true')
  expect(await git(fixPath, 'rev-parse', 'HEAD')).toBe(
    await git(repo, 'rev-parse', 'refs/remotes/origin/alex/fix')
  )

  const otherPath = join(root, 'other')
  await addWorktree(repo, otherPath, 'feature/new', 'origin/main')
  expect(await upstreamOf(otherPath, 'feature/new')).toBeNull()
})
