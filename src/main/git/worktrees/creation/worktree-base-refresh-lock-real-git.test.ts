import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as gitRunner from '../../command-runner/git-exec-file'
import { refreshLocalBaseRefForWorktreeCreate } from './worktree-base-refresh'

const tempRoots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
}

// `main` one commit behind `refs/remotes/origin/main`; `lock` names a file another Git process could hold.
async function createBehindRepo(lock: 'main-ref' | 'index' = 'main-ref'): Promise<{
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
  if (lock === 'main-ref') {
    git(repoPath, ['checkout', '--quiet', '-b', 'develop'])
  }
  const lockPath = join(repoPath, '.git', lock === 'index' ? 'index.lock' : 'refs/heads/main.lock')
  await writeFile(lockPath, '')
  return { repoPath, lockPath, localOid, remoteOid }
}

function isWrite(args: readonly string[]): boolean {
  return args.includes('update-ref') || args.includes('merge')
}

/** Counts writes; `onFailure` runs after each failed one, before it is reported. */
function spyOnFastForwards(onFailure: () => Promise<void> | void = () => {}): {
  writes: () => number
  maxConcurrent: () => number
} {
  const original = gitRunner.gitExecFileAsync
  let writes = 0
  let active = 0
  let maxConcurrent = 0
  vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    if (!isWrite(args)) {
      return original(args, options)
    }
    writes += 1
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
  return { writes: () => writes, maxConcurrent: () => maxConcurrent }
}

function refresh(repoPath: string, remote: 'origin' | 'upstream' = 'origin') {
  return refreshLocalBaseRefForWorktreeCreate(
    repoPath,
    `${remote}/main`,
    `refs/remotes/${remote}/main`
  )
}

// A fork: `main` behind `origin/main`, which is one commit behind `upstream/main`.
async function createForkRepo(): Promise<{
  repoPath: string
  originOid: string
  upstreamOid: string
}> {
  const { repoPath, lockPath, remoteOid: originOid } = await createBehindRepo()
  await rm(lockPath, { force: true })
  git(repoPath, ['checkout', '--quiet', '-b', 'fork-upstream', originOid])
  await writeFile(join(repoPath, 'version.txt'), 'three\n')
  git(repoPath, ['commit', '--quiet', '-am', 'three'])
  const upstreamOid = git(repoPath, ['rev-parse', 'HEAD'])
  git(repoPath, ['checkout', '--quiet', 'develop'])
  git(repoPath, ['update-ref', 'refs/remotes/upstream/main', upstreamOid])
  git(repoPath, ['branch', '--quiet', '-D', 'fork-upstream'])
  return { repoPath, originOid, upstreamOid }
}

beforeEach(() => {
  // Isolate fixtures from developer Git settings such as merge.verifySignatures.
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_CONFIG_GLOBAL', join(tmpdir(), `orca-no-global-gitconfig-${process.pid}`))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('local base refresh of a checked-out branch with real Git', () => {
  it('leaves it alone while another Git process holds its index.lock', async () => {
    const { repoPath, lockPath, localOid } = await createBehindRepo('index')
    const spy = spyOnFastForwards()

    await expect(refresh(repoPath)).resolves.toBeUndefined()

    expect(spy.writes()).toBe(0)
    expect(git(repoPath, ['rev-parse', 'main'])).toBe(localOid)
    expect(await readFile(lockPath, 'utf8')).toBe('')
  })
})

describe('local base refresh of a branch a rebase has reserved with real Git', () => {
  it('leaves it alone although no worktree lists it as checked out', async () => {
    const { repoPath, lockPath, localOid } = await createBehindRepo()
    await rm(lockPath, { force: true })
    git(repoPath, ['checkout', '--quiet', 'main'])
    // Stops mid-rebase with HEAD detached; Git still treats main as in use.
    expect(() => git(repoPath, ['rebase', '--quiet', '--root', '--exec', 'false'])).toThrow()
    const spy = spyOnFastForwards()

    await expect(refresh(repoPath)).resolves.toBeUndefined()

    expect(spy.writes()).toBe(0)
    expect(git(repoPath, ['rev-parse', 'main'])).toBe(localOid)
  })

  it('leaves a branch alone while a linked worktree bisects it', async () => {
    const { repoPath, lockPath, localOid } = await createBehindRepo()
    await rm(lockPath, { force: true })
    const linkedPath = join(repoPath, '..', 'linked')
    git(repoPath, ['worktree', 'add', '--quiet', linkedPath, 'main'])
    git(linkedPath, ['bisect', 'start'])
    git(linkedPath, ['checkout', '--quiet', '--detach'])
    const spy = spyOnFastForwards()

    await expect(refresh(repoPath)).resolves.toBeUndefined()

    expect(spy.writes()).toBe(0)
    expect(git(repoPath, ['rev-parse', 'main'])).toBe(localOid)
  })
})

describe('local base refresh racing a checkout with real Git', () => {
  it('skips the write when the branch is checked out while update-ref waits to start', async () => {
    const { repoPath, lockPath, localOid } = await createBehindRepo()
    await rm(lockPath, { force: true })
    const original = gitRunner.gitExecFileAsync
    vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
      if (args[0] === 'update-ref') {
        git(repoPath, ['checkout', '--quiet', 'main'])
      }
      return original(args, options)
    })

    await expect(refresh(repoPath)).resolves.toBeUndefined()

    expect(git(repoPath, ['rev-parse', 'main'])).toBe(localOid)
    expect(git(repoPath, ['status', '--porcelain'])).toBe('')
  })
})

describe('local base refresh against a held ref lock with real Git', () => {
  it('retries once the other git process releases the lock', async () => {
    const { repoPath, lockPath, remoteOid } = await createBehindRepo()
    const spy = spyOnFastForwards(() => rm(lockPath, { force: true }))

    const result = await refresh(repoPath)

    expect(result).toMatchObject({ status: 'updated' })
    expect(spy.writes()).toBe(2)
    expect(git(repoPath, ['rev-parse', 'main'])).toBe(remoteOid)
  })

  it('reports updated when another process fast-forwarded local while holding the lock', async () => {
    const { repoPath, lockPath, remoteOid } = await createBehindRepo()
    spyOnFastForwards(async () => {
      await rm(lockPath, { force: true })
      git(repoPath, ['update-ref', 'refs/heads/main', remoteOid])
    })

    const result = await refresh(repoPath)

    expect(result).toMatchObject({ status: 'updated' })
    expect(git(repoPath, ['rev-parse', 'main'])).toBe(remoteOid)
  })

  it('reports skipped_error when the lock outlives every retry', async () => {
    const { repoPath, localOid } = await createBehindRepo()
    const spy = spyOnFastForwards()

    const result = await refresh(repoPath)

    expect(result).toMatchObject({ status: 'skipped_error' })
    expect(spy.writes()).toBe(4)
    expect(git(repoPath, ['rev-parse', 'main'])).toBe(localOid)
  })
})

describe('concurrent local base refreshes of one repo with real Git', () => {
  it('runs one fast-forward and resolves every create without a warning', async () => {
    const { repoPath, lockPath, remoteOid } = await createBehindRepo()
    await rm(lockPath, { force: true })
    const spy = spyOnFastForwards()
    const warn = vi.spyOn(console, 'warn')

    const results = await Promise.all([refresh(repoPath), refresh(repoPath), refresh(repoPath)])

    expect(results[0]).toEqual({ baseRef: 'origin/main', localBranch: 'main', status: 'updated' })
    expect(results.slice(1)).toEqual([undefined, undefined])
    expect(spy.writes()).toBe(1)
    expect(warn).not.toHaveBeenCalled()
    expect(git(repoPath, ['rev-parse', 'main'])).toBe(remoteOid)
  })
})

describe('concurrent local base refreshes toward different remotes with real Git', () => {
  it('coalesces matching queued targets and reports each remote’s own outcome', async () => {
    const { repoPath, upstreamOid } = await createForkRepo()
    const spy = spyOnFastForwards()

    const results = await Promise.all([
      refresh(repoPath, 'origin'),
      refresh(repoPath, 'upstream'),
      refresh(repoPath, 'upstream'),
      refresh(repoPath, 'origin')
    ])

    expect(results[0]).toMatchObject({ baseRef: 'origin/main', status: 'updated' })
    expect(results[1]).toMatchObject({ baseRef: 'upstream/main', status: 'updated' })
    expect(results[2]).toEqual(results[1])
    expect(results[3]).toMatchObject({ baseRef: 'origin/main', status: 'skipped_not_fast_forward' })
    expect(git(repoPath, ['rev-parse', 'main'])).toBe(upstreamOid)
    expect(spy.maxConcurrent()).toBe(1)
  })
})
