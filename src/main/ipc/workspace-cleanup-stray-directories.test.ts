import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import { listRepoWorktrees } from '../repo-worktrees'
import {
  scanWorkspaceCleanupStrayDirectories,
  scanWorkspaceCleanupStrayDirectoriesForScan
} from './workspace-cleanup-stray-directories'
import { trashWorkspaceCleanupStrayDirectory } from './workspace-cleanup-stray-directory-trash'

const DAY_MS = 24 * 60 * 60 * 1000
let root = ''

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

async function makeFolder(folderPath: string, ageDays: number): Promise<string> {
  await mkdir(folderPath, { recursive: true })
  const at = new Date(Date.now() - ageDays * DAY_MS)
  await utimes(folderPath, at, at)
  return folderPath
}

function makeStore(repos: Repo[], settings: Partial<GlobalSettings> = {}) {
  const resolved: GlobalSettings = {
    ...getDefaultSettings(root),
    workspaceDir: join(root, 'global-workspaces'),
    nestWorkspaces: false,
    ...settings
  }
  return { getRepos: () => repos, getSettings: () => resolved }
}

async function listRegistered(repo: Repo): Promise<string[]> {
  return (await listRepoWorktrees(repo)).map((worktree) => worktree.path)
}

describe('unregistered worktree-root folders', () => {
  let repo: Repo
  let worktreeRoot = ''
  let registered = ''

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-cleanup-stray-')))
    const emptyConfig = join(root, 'gitconfig')
    await writeFile(emptyConfig, '')
    vi.stubEnv('GIT_CONFIG_GLOBAL', emptyConfig)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    const repoPath = join(root, 'repo')
    git(root, ['init', '--quiet', repoPath])
    await writeFile(join(repoPath, 'README.md'), 'base\n')
    git(repoPath, ['add', 'README.md'])
    git(repoPath, ['-c', 'user.name=T', '-c', 'user.email=t@e.invalid', 'commit', '-qm', 'init'])
    worktreeRoot = join(root, 'worktrees')
    repo = {
      id: 'repo-1',
      path: repoPath,
      displayName: 'Repo',
      badgeColor: '#000',
      addedAt: 0,
      worktreeBasePath: worktreeRoot
    }
    registered = join(worktreeRoot, 'registered')
    git(repoPath, ['worktree', 'add', '--quiet', '-b', 'registered', registered])
    await utimes(registered, new Date(0), new Date(0))
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  async function seedFlatRoot(): Promise<{ plain: string; broken: string; nestedRepo: string }> {
    const plain = await makeFolder(join(worktreeRoot, 'leftover-plain'), 10)
    const broken = join(worktreeRoot, 'leftover-broken-link')
    await mkdir(broken)
    await writeFile(join(broken, '.git'), `gitdir: ${join(repo.path, '.git/worktrees/gone')}\n`)
    const linkAge = new Date(Date.now() - 20 * DAY_MS)
    await utimes(join(broken, '.git'), linkAge, linkAge)
    await makeFolder(broken, 20)
    const nestedRepo = join(worktreeRoot, 'nested-repo')
    git(root, ['init', '--quiet', nestedRepo])
    await makeFolder(nestedRepo, 30)
    const liveLink = join(worktreeRoot, 'live-link')
    await mkdir(liveLink)
    await writeFile(join(liveLink, '.git'), `gitdir: ${join(repo.path, '.git')}\n`)
    await makeFolder(liveLink, 30)
    await makeFolder(join(worktreeRoot, 'just-created'), 0)
    await makeFolder(join(worktreeRoot, '.orca-preparing'), 30)
    await symlink(await makeFolder(join(root, 'elsewhere'), 30), join(worktreeRoot, 'link'))
    return { plain, broken, nestedRepo }
  }

  it('reports only unproven leftovers, as review-only rows', async () => {
    const { plain, broken } = await seedFlatRoot()

    const scan = await scanWorkspaceCleanupStrayDirectories({
      store: makeStore([repo]),
      registeredWorktreePaths: [repo.path, registered],
      scannedAt: Date.now()
    })

    expect(scan?.directories.map((directory) => directory.path)).toEqual([broken, plain])
    expect(scan?.directories[0]).toMatchObject({
      rootPath: worktreeRoot,
      repoIds: ['repo-1'],
      gitLink: 'missing-gitdir',
      reasons: ['unregistered'],
      tier: 'review',
      selectedByDefault: false
    })
    expect(scan?.directories[1]?.gitLink).toBe('none')
    expect(scan?.skippedRoots).toEqual([])
  })

  it('reads only project folders under a nested root', async () => {
    const nested = await makeFolder(join(worktreeRoot, 'repo', 'leftover'), 10)
    await makeFolder(join(worktreeRoot, 'not-a-project-folder'), 10)

    const scan = await scanWorkspaceCleanupStrayDirectories({
      store: makeStore([repo], { nestWorkspaces: true }),
      registeredWorktreePaths: [repo.path, registered],
      scannedAt: Date.now()
    })

    expect(scan?.directories.map((directory) => directory.path)).toEqual([nested])
    expect(scan?.directories[0]?.containerName).toBe('repo')
  })

  it('skips roots that hold projects, remote hosts and WSL with a reason', async () => {
    await makeFolder(join(root, 'someone-elses-folder'), 10)
    const sharedRoot = { ...repo, worktreeBasePath: root }
    const remote = { ...repo, id: 'repo-2', connectionId: 'ssh-1' }

    const scan = await scanWorkspaceCleanupStrayDirectories({
      store: makeStore([sharedRoot, remote]),
      registeredWorktreePaths: [],
      scannedAt: Date.now()
    })

    expect(scan?.directories).toEqual([])
    expect(scan?.skippedRoots).toEqual(
      expect.arrayContaining([
        { reason: 'remote-host', count: 1 },
        { reason: 'holds-projects', count: 1 }
      ])
    )
  })

  it('reads worktree roots only for the full-list broad scan', async () => {
    await seedFlatRoot()
    const store = makeStore([repo])
    const result = { scannedAt: Date.now(), candidates: [] }

    for (const args of [{}, { includeAllWorkspaces: true, worktreeIds: [] }]) {
      await expect(
        scanWorkspaceCleanupStrayDirectoriesForScan(store, args, result)
      ).resolves.toBeUndefined()
    }
    const broad = await scanWorkspaceCleanupStrayDirectoriesForScan(
      store,
      { includeAllWorkspaces: true },
      result
    )
    expect(broad?.directories.length).toBeGreaterThan(0)
  })

  it('moves a re-proven leftover to the OS trash and nothing else', async () => {
    const { plain, nestedRepo } = await seedFlatRoot()
    const trashItem = vi.fn(async () => {})
    const deps = { trashItem, listRegisteredWorktreePaths: listRegistered }
    const store = makeStore([repo])

    await expect(
      trashWorkspaceCleanupStrayDirectory(store, { path: plain }, deps)
    ).resolves.toEqual({ ok: true })
    expect(trashItem).toHaveBeenCalledExactlyOnceWith(plain)

    for (const refused of [nestedRepo, registered, repo.path, join(worktreeRoot, 'link')]) {
      const result = await trashWorkspaceCleanupStrayDirectory(store, { path: refused }, deps)
      expect(result.ok).toBe(false)
    }
    for (const invalid of ['relative/path', join(worktreeRoot, '.orca-preparing')]) {
      const result = await trashWorkspaceCleanupStrayDirectory(store, { path: invalid }, deps)
      expect(result).toEqual({ ok: false, message: 'Invalid folder path.' })
    }
    expect(trashItem).toHaveBeenCalledTimes(1)
  })

  it('surfaces a trash failure instead of deleting', async () => {
    const { plain } = await seedFlatRoot()
    const trashItem = vi.fn(async () => {
      throw new Error('No trash on this desktop')
    })

    const result = await trashWorkspaceCleanupStrayDirectory(
      makeStore([repo]),
      { path: plain },
      { trashItem, listRegisteredWorktreePaths: listRegistered }
    )

    expect(result).toEqual({ ok: false, message: 'No trash on this desktop' })
  })
})
