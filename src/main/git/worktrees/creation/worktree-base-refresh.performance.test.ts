import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as gitRunner from '../../command-runner/git-exec-file'
import {
  fastForwardCheckedOutLocalBaseAfterCreate,
  getLocalBaseRefUpdateSuggestionForWorktreeCreate,
  refreshLocalBaseRefForWorktreeCreate
} from './worktree-base-refresh'

// Perf contract (#46177): each workspace create listed every worktree two or three times to find who has local main.

const roots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
}

/** `main` one commit behind `origin/main`, with `linked` detached linked worktrees. */
async function createRepo(
  linked: number,
  initArgs: (root: string) => string[] = () => []
): Promise<{ repoPath: string; remoteOid: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-base-refresh-perf-'))
  roots.push(root)
  const repoPath = join(root, 'repo')
  execFileSync('git', ['init', '--quiet', ...initArgs(root), repoPath])
  git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repoPath, ['config', 'user.email', 'test@example.com'])
  git(repoPath, ['config', 'user.name', 'Test User'])
  await writeFile(join(repoPath, 'version.txt'), 'one\n')
  git(repoPath, ['add', 'version.txt'])
  git(repoPath, ['commit', '--quiet', '-m', 'one'])
  git(repoPath, ['checkout', '--quiet', '-b', 'upstream'])
  await writeFile(join(repoPath, 'version.txt'), 'two\n')
  git(repoPath, ['commit', '--quiet', '-am', 'two'])
  const remoteOid = git(repoPath, ['rev-parse', 'HEAD'])
  git(repoPath, ['update-ref', 'refs/remotes/origin/main', remoteOid])
  git(repoPath, ['checkout', '--quiet', '-b', 'develop', 'main'])
  git(repoPath, ['branch', '--quiet', '-D', 'upstream'])
  for (let index = 0; index < linked; index += 1) {
    git(repoPath, ['worktree', 'add', '--quiet', '--detach', join(root, `wt-${index}`)])
  }
  return { repoPath, remoteOid }
}

function countWorktreeListings(): () => number {
  const original = gitRunner.gitExecFileAsync
  let listings = 0
  vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    if (args.includes('worktree') && args.includes('list')) {
      listings += 1
    }
    return original(args, options)
  })
  return () => listings
}

async function refreshAndFollowUp(repoPath: string, owner: string, remoteOid: string) {
  await refreshLocalBaseRefForWorktreeCreate(repoPath, 'origin/main', 'refs/remotes/origin/main')
  fastForwardCheckedOutLocalBaseAfterCreate(repoPath, 'origin/main', 'refs/remotes/origin/main', {})
  // The follow-up runs detached; Windows Git takes seconds.
  await vi.waitFor(() => expect(git(owner, ['rev-parse', 'HEAD'])).toBe(remoteOid), {
    timeout: 25_000,
    interval: 250
  })
}

beforeEach(() => {
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_CONFIG_GLOBAL', join(tmpdir(), `orca-no-global-gitconfig-${process.pid}`))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each([3, 30])('moves an unchecked-out main without listing %i worktrees', async (linked) => {
  const { repoPath, remoteOid } = await createRepo(linked)
  const listings = countWorktreeListings()

  await expect(
    refreshLocalBaseRefForWorktreeCreate(repoPath, 'origin/main', 'refs/remotes/origin/main')
  ).resolves.toMatchObject({ status: 'updated' })

  expect(git(repoPath, ['rev-parse', 'main'])).toBe(remoteOid)
  expect(listings()).toBe(0)
})

it.each([3, 30])(
  'fast-forwards main in its primary checkout without listing %i worktrees',
  async (linked) => {
    const { repoPath, remoteOid } = await createRepo(linked)
    git(repoPath, ['checkout', '--quiet', 'main'])
    const listings = countWorktreeListings()

    await refreshAndFollowUp(repoPath, repoPath, remoteOid)

    expect(listings()).toBe(0)
  }
)

it.each([3, 30])(
  'fast-forwards main in its linked checkout without listing %i worktrees',
  async (linked) => {
    const { repoPath, remoteOid } = await createRepo(linked)
    const owner = join(repoPath, '..', 'wt-0')
    git(owner, ['checkout', '--quiet', 'main'])
    const listings = countWorktreeListings()

    await refreshAndFollowUp(repoPath, owner, remoteOid)

    expect(listings()).toBe(0)
  }
)

it.each([3, 30])(
  'suggests updating a checked-out main without listing %i worktrees',
  async (linked) => {
    const { repoPath } = await createRepo(linked, (root) => [
      '--separate-git-dir',
      join(root, 'repo-git')
    ])
    git(repoPath, ['checkout', '--quiet', 'main'])
    const listings = countWorktreeListings()

    await expect(
      getLocalBaseRefUpdateSuggestionForWorktreeCreate(
        repoPath,
        'origin/main',
        'refs/remotes/origin/main'
      )
    ).resolves.toEqual({ baseRef: 'origin/main', localBranch: 'main', behind: 1 })

    expect(listings()).toBe(0)
  }
)
