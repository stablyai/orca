// Real Git proves each action runs in the submodule and leaves the parent repository alone.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rmdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installRealWorkerThreadChildProcesses } from '../../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { removeTree } from '../../../shared/windows-transient-lock-removal'
import { gitFetch, gitPull, gitPush } from '../remote'
import { listSubmoduleRepos, resolveInitializedSubmodulePath } from './submodule-repos'
import { clearSubmodulePathsCache } from './submodule-paths'

const execFileAsync = promisify(execFile)

installRealWorkerThreadChildProcesses()

let scratch = ''
let remote = ''
let parent = ''

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    [
      '-c',
      'protocol.file.allow=always',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'user.name=T',
      ...args
    ],
    { cwd }
  )
  return stdout.trim()
}

async function commitFile(cwd: string, name: string): Promise<string> {
  await writeFile(join(cwd, name), `${name}\n`)
  await git(cwd, 'add', name)
  await git(cwd, 'commit', '-qm', name)
  return git(cwd, 'rev-parse', 'HEAD')
}

beforeEach(async () => {
  clearSubmodulePathsCache()
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'orca-submodule-repos-')))
  const seed = join(scratch, 'seed')
  remote = join(scratch, 'remote.git')
  parent = join(scratch, 'parent')
  for (const dir of [seed, parent]) {
    await mkdir(dir, { recursive: true })
    await git(dir, 'init', '-q', '-b', 'main')
  }
  await commitFile(seed, 'a.txt')
  await git(scratch, 'clone', '-q', '--bare', seed, remote)
  await commitFile(parent, 'root.txt')
  await git(parent, 'submodule', 'add', '-q', remote, 'libs/sub')
  await git(parent, 'submodule', 'add', '-q', remote, 'libs/other')
  await git(parent, 'commit', '-qm', 'add submodules')
})

afterEach(async () => {
  await removeTree(scratch)
})

describe('listSubmoduleRepos', () => {
  it('lists each initialized submodule with its branch and ahead/behind', async () => {
    const sub = join(parent, 'libs/sub')
    await git(sub, 'checkout', '-q', '-B', 'main', 'origin/main')
    await commitFile(sub, 'local.txt')
    await git(join(parent, 'libs/other'), 'checkout', '-q', '--detach')

    const repos = await listSubmoduleRepos(parent)

    expect(repos).toEqual([
      {
        path: 'libs/other',
        branch: null,
        upstream: null
      },
      {
        path: 'libs/sub',
        branch: 'main',
        upstream: { hasUpstream: true, upstreamName: 'origin/main', ahead: 1, behind: 0 }
      }
    ])
  })

  it('leaves out a submodule that is not initialized', async () => {
    const clone = join(scratch, 'clone')
    await git(scratch, 'clone', '-q', parent, clone)
    await git(clone, 'submodule', 'update', '-q', '--init', 'libs/sub')

    expect((await listSubmoduleRepos(clone)).map((repo) => repo.path)).toEqual(['libs/sub'])
  })
})

describe('resolveInitializedSubmodulePath', () => {
  it('resolves a listed submodule', async () => {
    await expect(resolveInitializedSubmodulePath(parent, 'libs/sub')).resolves.toBe(
      join(parent, 'libs/sub')
    )
  })

  it('refuses a folder that .gitmodules does not list', async () => {
    await mkdir(join(parent, 'plain/.git'), { recursive: true })
    await expect(resolveInitializedSubmodulePath(parent, 'plain')).rejects.toThrow(
      'not a submodule'
    )
  })

  it.each(['../remote.git', '/etc', 'libs/sub/../../..', ''])('refuses %j', async (value) => {
    await expect(resolveInitializedSubmodulePath(parent, value)).rejects.toThrow()
  })

  it('refuses a submodule that is not initialized', async () => {
    const clone = join(scratch, 'clone')
    await git(scratch, 'clone', '-q', parent, clone)
    await expect(resolveInitializedSubmodulePath(clone, 'libs/sub')).rejects.toThrow(
      'not initialized'
    )
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a submodule folder that links outside the worktree',
    async () => {
      const outside = join(scratch, 'outside')
      await mkdir(join(outside, '.git'), { recursive: true })
      const clone = join(scratch, 'clone')
      await git(scratch, 'clone', '-q', parent, clone)
      await rmdir(join(clone, 'libs/sub'))
      await symlink(outside, join(clone, 'libs/sub'))
      await expect(resolveInitializedSubmodulePath(clone, 'libs/sub')).rejects.toThrow(
        'escapes the selected worktree'
      )
    }
  )
})

describe('remote actions on a resolved submodule path', () => {
  it('pushes the submodule branch and leaves the parent repository alone', async () => {
    const sub = await resolveInitializedSubmodulePath(parent, 'libs/sub')
    await git(sub, 'checkout', '-q', '-B', 'main', 'origin/main')
    const head = await commitFile(sub, 'pushed.txt')
    const parentHead = await git(parent, 'rev-parse', 'HEAD')

    await gitPush(sub)

    expect(await git(remote, 'rev-parse', 'main')).toBe(head)
    expect(await git(parent, 'rev-parse', 'HEAD')).toBe(parentHead)
  })

  it('pulls into the submodule and the parent only sees a changed pointer', async () => {
    const sub = await resolveInitializedSubmodulePath(parent, 'libs/sub')
    await git(sub, 'checkout', '-q', '-B', 'main', 'origin/main')
    const other = join(scratch, 'other-clone')
    await git(scratch, 'clone', '-q', remote, other)
    const upstreamHead = await commitFile(other, 'upstream.txt')
    await git(other, 'push', '-q', 'origin', 'main')
    const parentHead = await git(parent, 'rev-parse', 'HEAD')

    await gitPull(sub)

    expect(await git(sub, 'rev-parse', 'HEAD')).toBe(upstreamHead)
    expect(await git(parent, 'rev-parse', 'HEAD')).toBe(parentHead)
    expect(await git(parent, 'status', '--porcelain')).toContain('libs/sub')
  })

  it('fetches new remote commits without moving the branch', async () => {
    const sub = await resolveInitializedSubmodulePath(parent, 'libs/sub')
    await git(sub, 'checkout', '-q', '-B', 'main', 'origin/main')
    const before = await git(sub, 'rev-parse', 'HEAD')
    const other = join(scratch, 'other-clone')
    await git(scratch, 'clone', '-q', remote, other)
    const upstreamHead = await commitFile(other, 'upstream.txt')
    await git(other, 'push', '-q', 'origin', 'main')

    await gitFetch(sub)

    expect(await git(sub, 'rev-parse', 'HEAD')).toBe(before)
    expect(await git(sub, 'rev-parse', 'origin/main')).toBe(upstreamHead)
  })
})
