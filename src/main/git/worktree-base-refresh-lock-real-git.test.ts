import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as gitRunner from './runner'
import { refreshLocalBaseRefForWorktreeCreate } from './worktree-base-refresh'

const tempRoots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
}

// Primary checkout on `main` one commit behind `refs/remotes/origin/main`, with its index locked.
async function createBehindRepoWithIndexLock(): Promise<{
  repoPath: string
  lockPath: string
  localOid: string
  remoteOid: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'orca-base-refresh-lock-'))
  tempRoots.push(root)
  const repoPath = join(root, 'repo')
  execFileSync('git', ['init', '--quiet', repoPath])
  git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repoPath, ['config', 'user.email', 'test@example.com'])
  git(repoPath, ['config', 'user.name', 'Test User'])
  git(repoPath, ['config', 'core.autocrlf', 'false'])
  await writeFile(join(repoPath, 'version.txt'), 'one\n')
  git(repoPath, ['add', 'version.txt'])
  git(repoPath, ['commit', '--quiet', '-m', 'one'])
  const localOid = git(repoPath, ['rev-parse', 'HEAD'])
  git(repoPath, ['checkout', '--quiet', '-b', 'upstream'])
  await writeFile(join(repoPath, 'version.txt'), 'two\n')
  git(repoPath, ['commit', '--quiet', '-am', 'two'])
  const remoteOid = git(repoPath, ['rev-parse', 'HEAD'])
  git(repoPath, ['checkout', '--quiet', 'main'])
  git(repoPath, ['update-ref', 'refs/remotes/origin/main', remoteOid])
  git(repoPath, ['branch', '--quiet', '-D', 'upstream'])
  const lockPath = join(repoPath, '.git', 'index.lock')
  await writeFile(lockPath, '')
  return { repoPath, lockPath, localOid, remoteOid }
}

function isOwnerFastForward(args: readonly string[]): boolean {
  return args.includes('merge') && args.includes('--ff-only')
}

/** Counts owner fast-forwards; `onFailure` runs after each failed one, before it is reported. */
function spyOnFastForwards(onFailure: () => Promise<void> | void = () => {}): {
  merges: () => number
  maxConcurrent: () => number
} {
  const original = gitRunner.gitExecFileAsync
  let merges = 0
  let active = 0
  let maxConcurrent = 0
  vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    if (!isOwnerFastForward(args)) {
      return original(args, options)
    }
    merges += 1
    active += 1
    maxConcurrent = Math.max(maxConcurrent, active)
    try {
      return await original(args, options)
    } catch (error) {
      await onFailure()
      throw error
    } finally {
      active -= 1
    }
  })
  return { merges: () => merges, maxConcurrent: () => maxConcurrent }
}

function refresh(repoPath: string, remote: 'origin' | 'upstream' = 'origin') {
  return refreshLocalBaseRefForWorktreeCreate(
    repoPath,
    `${remote}/main`,
    `refs/remotes/${remote}/main`
  )
}

// A fork: checked-out `main` behind `origin/main`, which is one commit behind `upstream/main`.
async function createForkRepo(): Promise<{
  repoPath: string
  originOid: string
  upstreamOid: string
}> {
  const { repoPath, lockPath, remoteOid: originOid } = await createBehindRepoWithIndexLock()
  await rm(lockPath, { force: true })
  git(repoPath, ['checkout', '--quiet', '-b', 'fork-upstream', originOid])
  await writeFile(join(repoPath, 'version.txt'), 'three\n')
  git(repoPath, ['commit', '--quiet', '-am', 'three'])
  const upstreamOid = git(repoPath, ['rev-parse', 'HEAD'])
  git(repoPath, ['checkout', '--quiet', 'main'])
  git(repoPath, ['update-ref', 'refs/remotes/upstream/main', upstreamOid])
  git(repoPath, ['branch', '--quiet', '-D', 'fork-upstream'])
  return { repoPath, originOid, upstreamOid }
}

beforeEach(() => {
  // Why: a developer's global config (e.g. merge.verifySignatures) must not change what these repos do.
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_CONFIG_GLOBAL', join(tmpdir(), `orca-no-global-gitconfig-${process.pid}`))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('local base refresh against a held index.lock with real Git', () => {
  it('retries once the other git process releases the lock', async () => {
    const { repoPath, lockPath, remoteOid } = await createBehindRepoWithIndexLock()
    const spy = spyOnFastForwards(() => rm(lockPath, { force: true }))

    const result = await refresh(repoPath)

    expect(result).toMatchObject({ status: 'updated' })
    expect(spy.merges()).toBe(2)
    expect(git(repoPath, ['rev-parse', 'main'])).toBe(remoteOid)
    expect(await readFile(join(repoPath, 'version.txt'), 'utf8')).toBe('two\n')
  })

  it('reports updated when another process fast-forwarded local while holding the lock', async () => {
    const { repoPath, remoteOid } = await createBehindRepoWithIndexLock()
    spyOnFastForwards(() => {
      git(repoPath, ['update-ref', 'refs/heads/main', remoteOid])
    })

    const result = await refresh(repoPath)

    expect(result).toMatchObject({ status: 'updated' })
    expect(git(repoPath, ['rev-parse', 'main'])).toBe(remoteOid)
  })

  it('reports skipped_error when the lock outlives every retry', async () => {
    const { repoPath, localOid } = await createBehindRepoWithIndexLock()
    const spy = spyOnFastForwards()

    const result = await refresh(repoPath)

    expect(result).toMatchObject({ status: 'skipped_error' })
    expect(spy.merges()).toBe(4)
    expect(git(repoPath, ['rev-parse', 'main'])).toBe(localOid)
  })
})

describe('concurrent local base refreshes of one repo with real Git', () => {
  it('runs one fast-forward and resolves every create without a warning', async () => {
    const { repoPath, lockPath, remoteOid } = await createBehindRepoWithIndexLock()
    await rm(lockPath, { force: true })
    const spy = spyOnFastForwards()
    const warn = vi.spyOn(console, 'warn')

    const results = await Promise.all([refresh(repoPath), refresh(repoPath), refresh(repoPath)])

    expect(results[0]).toMatchObject({ status: 'updated', ownerWorktreePath: expect.any(String) })
    // The joiners share one follow-up run, which finds local already current.
    expect(results.slice(1)).toEqual([undefined, undefined])
    expect(spy.merges()).toBe(1)
    expect(warn).not.toHaveBeenCalled()
    expect(git(repoPath, ['rev-parse', 'main'])).toBe(remoteOid)
  })
})

describe('concurrent local base refreshes toward different remotes with real Git', () => {
  it('moves local to a target a later create from another remote asked for', async () => {
    const { repoPath, upstreamOid } = await createForkRepo()
    const spy = spyOnFastForwards()

    const results = await Promise.all([
      refresh(repoPath, 'origin'),
      refresh(repoPath, 'upstream'),
      refresh(repoPath, 'origin')
    ])

    expect(results[0]).toMatchObject({ baseRef: 'origin/main', status: 'updated' })
    expect(results[1]).toMatchObject({ baseRef: 'upstream/main', status: 'updated' })
    // Local is now ahead of origin/main: the existing ahead-of-requested-remote rule, not a sharing artifact.
    expect(results[2]).toMatchObject({ baseRef: 'origin/main', status: 'skipped_not_fast_forward' })
    expect(git(repoPath, ['rev-parse', 'main'])).toBe(upstreamOid)
    expect(spy.maxConcurrent()).toBe(1)
  })

  it('never answers a create with the outcome of another remote target', async () => {
    const { repoPath, upstreamOid } = await createForkRepo()
    const spy = spyOnFastForwards()

    const results = await Promise.all([
      refresh(repoPath, 'upstream'),
      refresh(repoPath, 'upstream'),
      refresh(repoPath, 'origin')
    ])

    expect(results[0]).toMatchObject({ baseRef: 'upstream/main', status: 'updated' })
    // Local already equals upstream/main, so the second upstream create has nothing to report.
    expect(results[1]).toBeUndefined()
    // Local is now ahead of origin/main: the existing ahead-of-requested-remote rule, not a sharing artifact.
    expect(results[2]).toMatchObject({ baseRef: 'origin/main', status: 'skipped_not_fast_forward' })
    expect(git(repoPath, ['rev-parse', 'main'])).toBe(upstreamOid)
    expect(spy.maxConcurrent()).toBe(1)
  })
})
