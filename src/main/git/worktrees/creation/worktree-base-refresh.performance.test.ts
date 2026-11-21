import { execFileSync } from 'node:child_process'
import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as gitRunner from '../../command-runner/git-exec-file'
import {
  fastForwardCheckedOutLocalBaseAfterCreate,
  getLocalBaseRefUpdateSuggestionForWorktreeCreate,
  refreshLocalBaseRefForWorktreeCreate
} from './worktree-base-refresh'

// Perf contract (#46177): each workspace create listed every worktree two or three times to find who has local main.

const roots: string[] = []
const refOpens = vi.hoisted(() => ({ count: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  const open: typeof actual.open = (path, ...rest) => {
    if (/\/refs\/(?:heads|worktree)\//.test(String(path).replaceAll('\\', '/'))) {
      refOpens.count += 1
    }
    return actual.open(path, ...rest)
  }
  return { ...actual, open }
})

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
  // A detached follow-up's Git child can still hold the directory on Windows.
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }))
  )
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

// Windows needs symlink privileges.
it.skipIf(process.platform === 'win32')(
  'moves main without listing when a checked-out branch is an absolute symlink',
  async () => {
    const { repoPath, remoteOid } = await createRepo(3)
    const owner = join(dirname(repoPath), 'wt-0')
    git(owner, ['checkout', '--quiet', '-b', 'other'])
    const target = join(dirname(repoPath), 'other-ref')
    await writeFile(target, `${git(owner, ['rev-parse', 'HEAD'])}\n`)
    await rm(join(repoPath, '.git', 'refs', 'heads', 'other'))
    await symlink(target, join(repoPath, '.git', 'refs', 'heads', 'other'))
    const listings = countWorktreeListings()

    await expect(
      refreshLocalBaseRefForWorktreeCreate(repoPath, 'origin/main', 'refs/remotes/origin/main')
    ).resolves.toMatchObject({ status: 'updated' })

    expect(git(repoPath, ['rev-parse', 'main'])).toBe(remoteOid)
    expect(listings()).toBe(0)
  }
)

it.each([3, 30])(
  'fast-forwards main in a primary checkout with a separate git dir without listing %i worktrees',
  async (linked) => {
    const { repoPath, remoteOid } = await createRepo(linked, (root) => [
      '--separate-git-dir',
      join(root, 'repo-git')
    ])
    git(repoPath, ['checkout', '--quiet', 'main'])
    const listings = countWorktreeListings()

    await refreshAndFollowUp(repoPath, repoPath, remoteOid)

    expect(listings()).toBe(0)
  }
)

it.each([3, 30])(
  'goes straight to the listing for a deleted checkout of main among %i branch worktrees',
  async (linked) => {
    const { repoPath } = await createRepo(linked)
    for (let index = 0; index < linked; index += 1) {
      git(join(dirname(repoPath), `wt-${index}`), ['checkout', '--quiet', '-b', `topic-${index}`])
    }
    const owner = join(dirname(repoPath), 'wt-0')
    git(owner, ['checkout', '--quiet', 'main'])
    await rm(owner, { recursive: true, force: true })
    const listings = countWorktreeListings()
    refOpens.count = 0

    fastForwardCheckedOutLocalBaseAfterCreate(
      repoPath,
      'origin/main',
      'refs/remotes/origin/main',
      {}
    )

    await vi.waitFor(() => expect(listings()).toBe(1), { timeout: 25_000, interval: 50 })
    // Only main's own ref, never the other checkouts' branches.
    expect(refOpens.count).toBe(1)
  }
)

it.each([3, 30])(
  'follows only the remembered odd alias on the next create among %i branch worktrees',
  async (linked) => {
    const { repoPath } = await createRepo(linked)
    for (let index = 0; index < linked; index += 1) {
      git(join(dirname(repoPath), `wt-${index}`), ['checkout', '--quiet', '-b', `topic-${index}`])
    }
    const heads = join(repoPath, '.git', 'refs', 'heads')
    // An alias out of refs/ is one the files cannot follow.
    await writeFile(join(heads, 'loop-a'), 'ref: refs/heads/loop-b\n')
    await writeFile(join(heads, 'loop-b'), 'ref: elsewhere/loop\n')
    await writeFile(join(repoPath, '.git', 'worktrees', 'wt-0', 'HEAD'), 'ref: refs/heads/loop-a\n')
    const suggest = () =>
      getLocalBaseRefUpdateSuggestionForWorktreeCreate(
        repoPath,
        'origin/main',
        'refs/remotes/origin/main'
      )
    await suggest()
    refOpens.count = 0

    await suggest()

    // main itself plus the two-ref loop.
    expect(refOpens.count).toBeLessThanOrEqual(3)
  }
)

it.each([3, 30])(
  'remembers which checkout an odd per-worktree alias lives in among %i branch worktrees',
  async (linked) => {
    const { repoPath } = await createRepo(linked)
    for (let index = 0; index < linked; index += 1) {
      git(join(dirname(repoPath), `wt-${index}`), ['checkout', '--quiet', '-b', `topic-${index}`])
    }
    // The same alias name resolves in the first checkout and leaves refs/ in the last.
    const aliasIn = async (name: string, target: string) => {
      const gitDir = join(repoPath, '.git', 'worktrees', name)
      await mkdir(join(gitDir, 'refs', 'worktree'), { recursive: true })
      await writeFile(join(gitDir, 'refs', 'worktree', 'alias'), `ref: ${target}\n`)
      await writeFile(join(gitDir, 'HEAD'), 'ref: refs/worktree/alias\n')
    }
    await aliasIn('wt-0', 'refs/heads/topic-0')
    await aliasIn(`wt-${linked - 1}`, 'elsewhere/alias')
    const suggest = () =>
      getLocalBaseRefUpdateSuggestionForWorktreeCreate(
        repoPath,
        'origin/main',
        'refs/remotes/origin/main'
      )
    await suggest()
    refOpens.count = 0

    await suggest()

    // main itself plus the odd alias.
    expect(refOpens.count).toBeLessThanOrEqual(3)
  }
)
