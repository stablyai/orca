// addWorktree with refreshLocalBaseRef against real Git: a dirty base checkout is never touched,
// and only a local base that is actually behind its remote-tracking ref is reported as not refreshed.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addWorktree } from './worktree'
import { registerWorktreeSuiteHooks } from './worktree-test-harness'

registerWorktreeSuiteHooks()

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Orca Test',
      '-c',
      'user.email=orca@example.test',
      '-c',
      'commit.gpgSign=false',
      '-c',
      'core.hooksPath=.git/no-hooks',
      ...args
    ],
    { cwd, encoding: 'utf8' }
  ).trim()

describe('addWorktree local base refresh (real Git)', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function setup(): { root: string; base: string; advanceOrigin: () => string } {
    const root = mkdtempSync(join(tmpdir(), 'orca-local-base-refresh-'))
    roots.push(root)
    const origin = join(root, 'origin.git')
    const seed = join(root, 'seed')
    const base = join(root, 'base')
    git(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin)
    git(root, 'clone', '--quiet', origin, seed)
    git(seed, 'checkout', '--quiet', '-B', 'main')
    writeFileSync(join(seed, 'tracked.txt'), 'base\n')
    git(seed, 'add', 'tracked.txt')
    git(seed, 'commit', '--quiet', '-m', 'base')
    git(seed, 'push', '--quiet', 'origin', 'main')
    git(root, 'clone', '--quiet', origin, base)

    let counter = 0
    const advanceOrigin = (): string => {
      counter += 1
      writeFileSync(join(seed, 'remote.txt'), `remote ${counter}\n`)
      git(seed, 'add', 'remote.txt')
      git(seed, 'commit', '--quiet', '-m', `remote ${counter}`)
      git(seed, 'push', '--quiet', 'origin', 'main')
      git(base, 'fetch', '--quiet', 'origin')
      return git(base, 'rev-parse', 'refs/remotes/origin/main')
    }
    return { root, base, advanceOrigin }
  }

  function snapshotBase(base: string, files: string[]) {
    return {
      head: git(base, 'rev-parse', 'HEAD'),
      branch: git(base, 'symbolic-ref', 'HEAD'),
      status: git(base, 'status', '--porcelain', '--untracked-files=all'),
      files: files.map((file) => readFileSync(join(base, file)))
    }
  }

  it('dirty tracked file, local main current: creates from origin/main, no warning, base untouched', async () => {
    const { root, base } = setup()
    writeFileSync(join(base, 'tracked.txt'), 'local work\r\nkeep me\n')
    const before = snapshotBase(base, ['tracked.txt'])

    const result = await addWorktree(base, join(root, 'task'), 'task', 'origin/main', true)

    expect(result.localBaseRefRefresh).toBeUndefined()
    expect(git(join(root, 'task'), 'rev-parse', 'HEAD')).toBe(
      git(base, 'rev-parse', 'refs/remotes/origin/main')
    )
    expect(snapshotBase(base, ['tracked.txt'])).toEqual(before)
  })

  it('dirty untracked file, local main current: creates from origin/main, no warning, base untouched', async () => {
    const { root, base } = setup()
    writeFileSync(join(base, 'untracked.txt'), 'scratch notes\n')
    const before = snapshotBase(base, ['untracked.txt'])

    const result = await addWorktree(base, join(root, 'task'), 'task', 'origin/main', true)

    expect(result.localBaseRefRefresh).toBeUndefined()
    expect(git(join(root, 'task'), 'rev-parse', 'HEAD')).toBe(
      git(base, 'rev-parse', 'refs/remotes/origin/main')
    )
    expect(snapshotBase(base, ['untracked.txt'])).toEqual(before)
  })

  it('dirty tracked file, local main behind: creates from new origin/main and leaves base untouched', async () => {
    const { root, base, advanceOrigin } = setup()
    const remoteOid = advanceOrigin()
    writeFileSync(join(base, 'tracked.txt'), 'local work\n')
    const before = snapshotBase(base, ['tracked.txt'])

    const result = await addWorktree(base, join(root, 'task'), 'task', 'origin/main', true)

    // Non-blocking: the task worktree exists; the stale local main is only reported.
    expect(result.localBaseRefRefresh).toMatchObject({
      status: 'skipped_dirty_worktree',
      localBranch: 'main'
    })
    expect(git(join(root, 'task'), 'rev-parse', 'HEAD')).toBe(remoteOid)
    expect(snapshotBase(base, ['tracked.txt'])).toEqual(before)
  })

  it('clean base checkout, local main behind: fast-forwards local main as before', async () => {
    const { root, base, advanceOrigin } = setup()
    const remoteOid = advanceOrigin()

    const result = await addWorktree(base, join(root, 'task'), 'task', 'origin/main', true)

    expect(result.localBaseRefRefresh).toMatchObject({ status: 'updated', localBranch: 'main' })
    expect(git(base, 'rev-parse', 'refs/heads/main')).toBe(remoteOid)
    expect(git(join(root, 'task'), 'rev-parse', 'HEAD')).toBe(remoteOid)
    expect(git(base, 'status', '--porcelain')).toBe('')
  })

  it('clean base checkout, local main current: creates from origin/main without a warning', async () => {
    const { root, base } = setup()

    const result = await addWorktree(base, join(root, 'task'), 'task', 'origin/main', true)

    expect(result.localBaseRefRefresh).toBeUndefined()
    expect(git(join(root, 'task'), 'rev-parse', 'HEAD')).toBe(git(base, 'rev-parse', 'HEAD'))
  })

  it('still fails clearly when the requested base ref does not exist', async () => {
    const { root, base } = setup()
    writeFileSync(join(base, 'tracked.txt'), 'local work\n')

    await expect(
      addWorktree(base, join(root, 'task'), 'task', 'origin/does-not-exist', true)
    ).rejects.toThrow()
    expect(readFileSync(join(base, 'tracked.txt'), 'utf8')).toBe('local work\n')
  })
})
