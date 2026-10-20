import { runProcessSync } from '@orca/process-host'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { Store } from '../../persistence'
import { addLocalRepoFromPath } from './local-repo-registration'
import { detectRepoIconAndUpstream } from '../../repo-icon-autodetect'

vi.mock('../../repo-icon-autodetect', () => ({
  detectRepoIconAndUpstream: vi.fn().mockResolvedValue({})
}))
vi.mock('../../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn().mockResolvedValue(undefined)
}))

const dirLinkType = process.platform === 'win32' ? 'junction' : 'dir'

function createStore(repos: Repo[]): Store {
  const store = {
    getRepos: () => repos,
    addRepo: (repo: Repo) => {
      repos.push(repo)
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: addLocalRepoFromPath only calls getRepos/addRepo.
  return store as unknown as Store
}

describe('addLocalRepoFromPath through a symlink alias', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-local-add-alias-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('returns the tracked folder workspace instead of adding a duplicate', async () => {
    const folderPath = join(root, 'notes')
    await mkdir(folderPath)
    await symlink(folderPath, join(root, 'notes-link'), dirLinkType)
    const repos: Repo[] = []
    const store = createStore(repos)

    const first = await addLocalRepoFromPath(store, folderPath, 'folder')
    const second = await addLocalRepoFromPath(store, join(root, 'notes-link'), 'folder')

    expect('repo' in first && 'repo' in second && second.repo.id === first.repo.id).toBe(true)
    expect(second).toMatchObject({ alreadyExisted: true })
    expect(repos).toHaveLength(1)
  })

  it('keeps two different folders as two workspaces', async () => {
    await mkdir(join(root, 'a'))
    await mkdir(join(root, 'b'))
    const repos: Repo[] = []
    const store = createStore(repos)

    await addLocalRepoFromPath(store, join(root, 'a'), 'folder')
    await addLocalRepoFromPath(store, join(root, 'b'), 'folder')

    expect(repos).toHaveLength(2)
  })
})

function runGit(args: string[]): void {
  const result = runProcessSync({ program: 'git', args })
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
}

function gitInitWithCommit(path: string): void {
  runGit(['init', '-q', path])
  runGit([
    '-C',
    path,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init'
  ])
}

describe('addLocalRepoFromPath new Git repository observer', () => {
  let root: string

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-local-add-observer-')))
    vi.mocked(detectRepoIconAndUpstream).mockReset().mockResolvedValue({})
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reports a newly registered Git repo once, with its stored identity', async () => {
    const repoPath = join(root, 'repo')
    await mkdir(repoPath)
    gitInitWithCommit(repoPath)
    const repos: Repo[] = []
    const observer = vi.fn()

    const result = await addLocalRepoFromPath(
      createStore(repos),
      repoPath,
      'git',
      undefined,
      observer
    )

    expect(result).toMatchObject({ alreadyExisted: false })
    expect(observer).toHaveBeenCalledTimes(1)
    expect(observer).toHaveBeenCalledWith(repos[0])
    expect(repos[0]).toMatchObject({ kind: 'git', path: repoPath })
  })

  it('does not report a reopened path, a symlink alias, or a folder workspace', async () => {
    const repoPath = join(root, 'repo')
    await mkdir(repoPath)
    gitInitWithCommit(repoPath)
    await symlink(repoPath, join(root, 'repo-link'), dirLinkType)
    const folderPath = join(root, 'notes')
    await mkdir(folderPath)
    const repos: Repo[] = []
    const store = createStore(repos)
    const observer = vi.fn()

    await addLocalRepoFromPath(store, repoPath, 'git', undefined, observer)
    observer.mockClear()
    await addLocalRepoFromPath(store, repoPath, 'git', undefined, observer)
    await addLocalRepoFromPath(store, join(root, 'repo-link'), 'git', undefined, observer)
    await addLocalRepoFromPath(store, folderPath, 'folder', undefined, observer)

    expect(observer).not.toHaveBeenCalled()
    expect(repos).toHaveLength(2)
  })

  it('does not report a linked worktree of a tracked repo and adds no second row', async () => {
    const repoPath = join(root, 'repo')
    await mkdir(repoPath)
    gitInitWithCommit(repoPath)
    const linkedPath = join(root, 'linked')
    runGit(['-C', repoPath, 'worktree', 'add', '-q', '-b', 'feature', linkedPath])
    const repos: Repo[] = []
    const store = createStore(repos)
    await addLocalRepoFromPath(store, repoPath, 'git')
    const observer = vi.fn()

    const result = await addLocalRepoFromPath(store, linkedPath, 'git', undefined, observer)

    expect(result).toMatchObject({ alreadyExisted: true })
    expect(observer).not.toHaveBeenCalled()
    expect(repos).toHaveLength(1)
  })

  it('reports again when a removed repo is registered anew with a new id', async () => {
    const repoPath = join(root, 'repo')
    await mkdir(repoPath)
    gitInitWithCommit(repoPath)
    const repos: Repo[] = []
    const store = createStore(repos)
    const observer = vi.fn()

    await addLocalRepoFromPath(store, repoPath, 'git', undefined, observer)
    repos.length = 0
    await addLocalRepoFromPath(store, repoPath, 'git', undefined, observer)

    expect(observer).toHaveBeenCalledTimes(2)
    expect(observer.mock.calls[0][0].id).not.toBe(observer.mock.calls[1][0].id)
  })

  it('reports only the registration that wins the race during icon discovery', async () => {
    const repoPath = join(root, 'repo')
    await mkdir(repoPath)
    gitInitWithCommit(repoPath)
    const repos: Repo[] = []
    const store = createStore(repos)
    const loserObserver = vi.fn()
    const winnerObserver = vi.fn()
    let releaseLoser!: () => void
    vi.mocked(detectRepoIconAndUpstream).mockImplementationOnce(
      () => new Promise((resolve) => (releaseLoser = () => resolve({})))
    )

    const loser = addLocalRepoFromPath(store, repoPath, 'git', undefined, loserObserver)
    await vi.waitFor(() => expect(releaseLoser).toBeTypeOf('function'))
    const winner = await addLocalRepoFromPath(store, repoPath, 'git', undefined, winnerObserver)
    releaseLoser()
    const loserResult = await loser

    expect(winner).toMatchObject({ alreadyExisted: false })
    expect(loserResult).toMatchObject({ alreadyExisted: true })
    expect(repos).toHaveLength(1)
    expect(winnerObserver).toHaveBeenCalledTimes(1)
    expect(loserObserver).not.toHaveBeenCalled()
  })

  it('registers a new row when only foreign-host rows land at its path during icon discovery', async () => {
    const repoPath = join(root, 'repo')
    await mkdir(repoPath)
    gitInitWithCommit(repoPath)
    const foreign = (id: string, host: Partial<Repo>): Repo => ({
      id,
      path: repoPath,
      displayName: id,
      badgeColor: '#22c55e',
      addedAt: 1,
      kind: 'git',
      ...host
    })
    const repos: Repo[] = []
    const observer = vi.fn()
    vi.mocked(detectRepoIconAndUpstream).mockImplementationOnce(async () => {
      repos.push(
        foreign('runtime-row', { executionHostId: 'runtime:env-1' }),
        foreign('ssh-row', { connectionId: 'ssh-1' })
      )
      return {}
    })

    const result = await addLocalRepoFromPath(
      createStore(repos),
      repoPath,
      'git',
      undefined,
      observer
    )

    expect(result).toMatchObject({ alreadyExisted: false })
    expect(repos).toHaveLength(3)
    expect(repos.slice(0, 2).map((repo) => repo.id)).toEqual(['runtime-row', 'ssh-row'])
    expect(observer).toHaveBeenCalledTimes(1)
    expect(observer).toHaveBeenCalledWith(repos[2])
  })

  it('keeps the registration when the observer throws or rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const firstPath = join(root, 'first')
    const secondPath = join(root, 'second')
    await mkdir(firstPath)
    await mkdir(secondPath)
    gitInitWithCommit(firstPath)
    gitInitWithCommit(secondPath)
    const repos: Repo[] = []
    const store = createStore(repos)

    const thrown = await addLocalRepoFromPath(store, firstPath, 'git', undefined, () => {
      throw new Error('consumer failed')
    })
    const rejected = await addLocalRepoFromPath(store, secondPath, 'git', undefined, () =>
      Promise.reject(new Error('consumer rejected'))
    )
    await Promise.resolve()

    expect(thrown).toMatchObject({ alreadyExisted: false })
    expect(rejected).toMatchObject({ alreadyExisted: false })
    expect(repos).toHaveLength(2)
    warn.mockRestore()
  })
})
