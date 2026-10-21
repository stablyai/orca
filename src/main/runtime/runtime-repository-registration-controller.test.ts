import { runProcessSync } from '@orca/process-host'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import type { Repo } from '../../shared/repo-types'
import { RuntimeRepositoryRegistrationController } from './runtime-repository-registration-controller'
import { detectRepoIconAndUpstream } from '../repo-icon-autodetect'
import type { RuntimeStore } from './runtime-store-contract'

vi.mock('../repo-icon-autodetect', () => ({
  detectRepoIconAndUpstream: vi.fn().mockResolvedValue({})
}))
vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn().mockResolvedValue(undefined)
}))

const dirLinkType = process.platform === 'win32' ? 'junction' : 'dir'

function createController(): {
  controller: RuntimeRepositoryRegistrationController
  repos: Repo[]
} {
  const repos: Repo[] = []
  const store = {
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    addRepo: (repo: Repo) => {
      repos.push(repo)
      return repo
    },
    updateRepo: () => null
  }
  const controller = new RuntimeRepositoryRegistrationController({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: add() only uses getRepos/getRepo/addRepo/updateRepo.
    getStore: () => store as unknown as RuntimeStore,
    invalidateResolvedWorktrees: () => {},
    invalidateWorktreeScan: () => {},
    notifyReposChanged: () => {}
  })
  return { controller, repos }
}

function runGit(args: string[]): void {
  const result = runProcessSync({ program: 'git', args })
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
}

function gitInit(path: string): void {
  runGit(['init', '-q', path])
}

describe('RuntimeRepositoryRegistrationController.add through a symlink alias', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-runtime-add-alias-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('returns the tracked git project when its alias is added after the real path', async () => {
    const repoPath = join(root, 'repo')
    await mkdir(repoPath)
    gitInit(repoPath)
    await symlink(repoPath, join(root, 'repo-link'), dirLinkType)
    const { controller, repos } = createController()

    const first = await controller.add(repoPath, 'git')
    const second = await controller.add(join(root, 'repo-link'), 'git')

    expect(second.id).toBe(first.id)
    expect(repos).toHaveLength(1)
  })

  it('returns the tracked git project when the real path is added after its alias', async () => {
    const repoPath = join(root, 'repo')
    await mkdir(repoPath)
    gitInit(repoPath)
    await symlink(repoPath, join(root, 'repo-link'), dirLinkType)
    const { controller, repos } = createController()

    const first = await controller.add(join(root, 'repo-link'), 'git')
    const second = await controller.add(repoPath, 'git')

    expect(second.id).toBe(first.id)
    expect(repos).toHaveLength(1)
  })

  it('dedupes a folder workspace added through an alias', async () => {
    const folderPath = join(root, 'notes')
    await mkdir(folderPath)
    await symlink(folderPath, join(root, 'notes-link'), dirLinkType)
    const { controller, repos } = createController()

    const first = await controller.add(folderPath, 'folder')
    const second = await controller.add(join(root, 'notes-link'), 'folder')

    expect(second.id).toBe(first.id)
    expect(repos).toHaveLength(1)
  })

  it('keeps two different checkouts of the same repository as two projects', async () => {
    const repoPath = join(root, 'repo')
    await mkdir(repoPath)
    gitInit(repoPath)
    const clonePath = join(root, 'repo-copy')
    runGit(['clone', '-q', repoPath, clonePath])
    const { controller, repos } = createController()

    const first = await controller.add(repoPath, 'git')
    const second = await controller.add(clonePath, 'git')

    expect(second.id).not.toBe(first.id)
    expect(repos).toHaveLength(2)
  })

  it('does not resolve an SSH project path against this machine', async () => {
    const folderPath = join(root, 'notes')
    await mkdir(folderPath)
    const { controller, repos } = createController()
    repos.push({
      id: 'ssh-row',
      path: join(root, 'notes-elsewhere'),
      displayName: 'notes',
      badgeColor: 'blue',
      addedAt: 1,
      kind: 'folder',
      connectionId: 'ssh-1'
    })
    await symlink(folderPath, join(root, 'notes-elsewhere'), dirLinkType)

    const added = await controller.add(folderPath, 'folder')

    expect(added.id).not.toBe('ssh-row')
  })
})

describe('RuntimeRepositoryRegistrationController.add stores the checkout git lists', () => {
  let root: string

  beforeEach(async () => {
    // Why realpath: macOS tmpdir is itself a symlink, and the expectations name git's resolved root.
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-runtime-add-root-')))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('stores the real toplevel when a git project is added through a symlink alias', async () => {
    const repoPath = join(root, 'repo')
    await mkdir(repoPath)
    gitInit(repoPath)
    await symlink(repoPath, join(root, 'repo-link'), dirLinkType)
    const { controller } = createController()

    const added = await controller.add(join(root, 'repo-link'), 'git')

    expect(normalizeRuntimePathForComparison(added.path)).toBe(
      normalizeRuntimePathForComparison(repoPath)
    )
    expect(added.displayName).toBe('repo')
  })

  it('stores the toplevel when a subdirectory of a git checkout is added', async () => {
    const repoPath = join(root, 'mono')
    await mkdir(join(repoPath, 'pkg', 'web'), { recursive: true })
    gitInit(repoPath)
    const { controller } = createController()

    const added = await controller.add(join(repoPath, 'pkg', 'web'), 'git')

    expect(normalizeRuntimePathForComparison(added.path)).toBe(
      normalizeRuntimePathForComparison(repoPath)
    )
  })

  it.skipIf(process.platform === 'win32')(
    'keeps a literal backslash in a POSIX checkout name',
    async () => {
      const repoPath = join(root, 'repo\\name')
      await mkdir(repoPath)
      gitInit(repoPath)
      const { controller } = createController()

      const added = await controller.add(repoPath, 'git')

      expect(added.path).toBe(repoPath)
    }
  )

  it('keeps the typed path for a folder workspace reached through an alias', async () => {
    const folderPath = join(root, 'notes')
    await mkdir(folderPath)
    await symlink(folderPath, join(root, 'notes-link'), dirLinkType)
    const { controller } = createController()

    const added = await controller.add(join(root, 'notes-link'), 'folder')

    expect(added.path).toBe(join(root, 'notes-link'))
  })
})

function gitInitWithCommit(path: string): void {
  gitInit(path)
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

describe('RuntimeRepositoryRegistrationController new Git repository observer', () => {
  let root: string

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-runtime-add-observer-')))
    vi.mocked(detectRepoIconAndUpstream).mockReset().mockResolvedValue({})
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reports a newly added Git repo once, with its host stamp and stored path', async () => {
    const repoPath = join(root, 'repo')
    await mkdir(repoPath)
    gitInit(repoPath)
    const { controller, repos } = createController()
    const observer = vi.fn()

    const added = await controller.add(repoPath, 'git', 'runtime:env-1', undefined, observer)

    expect(observer).toHaveBeenCalledTimes(1)
    expect(observer).toHaveBeenCalledWith(repos[0])
    expect(added).toMatchObject({ id: repos[0].id, executionHostId: 'runtime:env-1' })
    expect(repos[0].path).toBe(repoPath)
  })

  it('does not report a reopen, a symlink alias, an adopted row, or a folder workspace', async () => {
    const repoPath = join(root, 'repo')
    await mkdir(repoPath)
    gitInit(repoPath)
    await symlink(repoPath, join(root, 'repo-link'), dirLinkType)
    const folderPath = join(root, 'notes')
    await mkdir(folderPath)
    const { controller, repos } = createController()
    const observer = vi.fn()
    await controller.add(repoPath, 'git')

    await controller.add(repoPath, 'git', undefined, undefined, observer)
    await controller.add(join(root, 'repo-link'), 'git', undefined, undefined, observer)
    await controller.add(repoPath, 'git', 'runtime:env-1', undefined, observer)
    await controller.add(folderPath, 'folder', undefined, undefined, observer)

    expect(observer).not.toHaveBeenCalled()
    expect(repos).toHaveLength(2)
  })

  it('does not report a linked worktree of a tracked repo and adds no second row', async () => {
    const repoPath = join(root, 'repo')
    await mkdir(repoPath)
    gitInitWithCommit(repoPath)
    const linkedPath = join(root, 'linked')
    runGit(['-C', repoPath, 'worktree', 'add', '-q', '-b', 'feature', linkedPath])
    const { controller, repos } = createController()
    const main = await controller.add(repoPath, 'git')
    const observer = vi.fn()

    const reused = await controller.add(linkedPath, 'git', undefined, undefined, observer)

    expect(reused.id).toBe(main.id)
    expect(observer).not.toHaveBeenCalled()
    expect(repos).toHaveLength(1)
  })

  it('does not reuse foreign-host rows at the owning checkout path of a linked worktree', async () => {
    const repoPath = join(root, 'repo')
    await mkdir(repoPath)
    gitInitWithCommit(repoPath)
    const linkedPath = join(root, 'linked')
    runGit(['-C', repoPath, 'worktree', 'add', '-q', '-b', 'feature', linkedPath])
    const { controller, repos } = createController()
    const foreign = (id: string, host: Partial<Repo>): Repo => ({
      id,
      path: repoPath,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      kind: 'git',
      ...host
    })
    const foreignRows = [
      foreign('ssh-row', { connectionId: 'ssh-1' }),
      foreign('runtime-row', { executionHostId: 'runtime:env-1' })
    ]
    repos.push(...foreignRows.map((row) => ({ ...row })))
    const observer = vi.fn()

    const added = await controller.add(linkedPath, 'git', undefined, undefined, observer)

    expect(foreignRows.map((row) => row.id)).not.toContain(added.id)
    expect(repos).toHaveLength(3)
    expect(repos.slice(0, 2)).toEqual(foreignRows)
    expect(observer).toHaveBeenCalledTimes(1)
    expect(observer.mock.calls[0][0].id).toBe(added.id)
  })

  it('reuses the owning checkout row stamped with the supplied runtime host for a linked worktree', async () => {
    const repoPath = join(root, 'repo')
    await mkdir(repoPath)
    gitInitWithCommit(repoPath)
    const linkedPath = join(root, 'linked')
    runGit(['-C', repoPath, 'worktree', 'add', '-q', '-b', 'feature', linkedPath])
    const { controller, repos } = createController()
    const main = await controller.add(repoPath, 'git', 'runtime:env-1')
    const observer = vi.fn()

    const reused = await controller.add(linkedPath, 'git', 'runtime:env-1', undefined, observer)

    expect(reused.id).toBe(main.id)
    expect(observer).not.toHaveBeenCalled()
    expect(repos).toHaveLength(1)
  })

  it('reuses a host-less local owning checkout row for a linked worktree added with a runtime host', async () => {
    const repoPath = join(root, 'repo')
    await mkdir(repoPath)
    gitInitWithCommit(repoPath)
    const linkedPath = join(root, 'linked')
    runGit(['-C', repoPath, 'worktree', 'add', '-q', '-b', 'feature', linkedPath])
    const { controller, repos } = createController()
    const main = await controller.add(repoPath, 'git')
    const observer = vi.fn()

    const reused = await controller.add(linkedPath, 'git', 'runtime:env-1', undefined, observer)

    expect(reused.id).toBe(main.id)
    expect(observer).not.toHaveBeenCalled()
    expect(repos).toHaveLength(1)
  })

  it('treats the same path on a different runtime host as a new registration', async () => {
    const repoPath = join(root, 'repo')
    await mkdir(repoPath)
    gitInit(repoPath)
    const { controller, repos } = createController()
    const observer = vi.fn()
    await controller.add(repoPath, 'git', 'runtime:env-1')

    await controller.add(repoPath, 'git', 'runtime:env-2', undefined, observer)

    expect(observer).toHaveBeenCalledTimes(1)
    expect(repos).toHaveLength(2)
  })

  it('reports only the add that wins the race during icon discovery', async () => {
    const repoPath = join(root, 'repo')
    await mkdir(repoPath)
    gitInit(repoPath)
    const { controller, repos } = createController()
    const loserObserver = vi.fn()
    const winnerObserver = vi.fn()
    let releaseLoser!: () => void
    vi.mocked(detectRepoIconAndUpstream).mockImplementationOnce(
      () => new Promise((resolve) => (releaseLoser = () => resolve({})))
    )

    const loser = controller.add(repoPath, 'git', undefined, undefined, loserObserver)
    await vi.waitFor(() => expect(releaseLoser).toBeTypeOf('function'))
    const winnerRepo = await controller.add(repoPath, 'git', undefined, undefined, winnerObserver)
    releaseLoser()
    const loserRepo = await loser

    expect(loserRepo.id).toBe(winnerRepo.id)
    expect(repos).toHaveLength(1)
    expect(winnerObserver).toHaveBeenCalledTimes(1)
    expect(loserObserver).not.toHaveBeenCalled()
  })

  it('announces every row it inserts, folder or Git, but not a reused one', async () => {
    const repoPath = join(root, 'repo')
    const folderPath = join(root, 'notes')
    await mkdir(repoPath)
    await mkdir(folderPath)
    gitInit(repoPath)
    const { controller, repos } = createController()
    const inserted = vi.fn()

    await controller.add(repoPath, 'git', undefined, undefined, undefined, inserted)
    await controller.add(repoPath, 'git', undefined, undefined, undefined, inserted)
    await controller.add(folderPath, 'folder', undefined, undefined, undefined, inserted)

    expect(inserted.mock.calls.map(([repo]) => repo)).toEqual(repos)
    expect(repos.map((repo) => repo.kind)).toEqual(['git', 'folder'])
  })

  it('keeps the registration when the observer throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const repoPath = join(root, 'repo')
    await mkdir(repoPath)
    gitInit(repoPath)
    const { controller, repos } = createController()

    const added = await controller.add(repoPath, 'git', undefined, undefined, () => {
      throw new Error('consumer failed')
    })

    expect(added.id).toBe(repos[0].id)
    warn.mockRestore()
  })

  it('create reports a created Git repo once, but not a folder or a repeat create', async () => {
    const { controller, repos } = createController()
    const observer = vi.fn()

    await controller.create(root, 'made', 'git', observer)
    await controller.create(root, 'made', 'git', observer)
    await controller.create(root, 'notes', 'folder', observer)

    expect(observer).toHaveBeenCalledTimes(1)
    expect(observer).toHaveBeenCalledWith(repos[0])
    expect(repos).toHaveLength(2)
  })

  it('create reports nothing when another registration lands during icon discovery', async () => {
    const { controller, repos } = createController()
    const observer = vi.fn()
    vi.mocked(detectRepoIconAndUpstream).mockImplementationOnce(async () => {
      repos.push({
        id: 'competitor',
        path: join(root, 'raced'),
        displayName: 'raced',
        badgeColor: 'blue',
        addedAt: 1,
        kind: 'git'
      })
      return {}
    })

    const result = await controller.create(root, 'raced', 'git', observer)

    expect(result).toMatchObject({ repo: { id: 'competitor' } })
    expect(repos).toHaveLength(1)
    expect(observer).not.toHaveBeenCalled()
  })

  it('create registers a new local row when only foreign-host rows land at its path during icon discovery', async () => {
    const { controller, repos } = createController()
    const observer = vi.fn()
    const foreign = (id: string, host: Partial<Repo>): Repo => ({
      id,
      path: join(root, 'made'),
      displayName: id,
      badgeColor: 'blue',
      addedAt: 1,
      kind: 'git',
      ...host
    })
    vi.mocked(detectRepoIconAndUpstream).mockImplementationOnce(async () => {
      repos.push(
        foreign('runtime-row', { executionHostId: 'runtime:env-1' }),
        foreign('ssh-row', { connectionId: 'ssh-1' })
      )
      return {}
    })

    const result = await controller.create(root, 'made', 'git', observer)

    expect(result).toMatchObject({ repo: { path: join(root, 'made') } })
    expect(repos).toHaveLength(3)
    expect(repos.slice(0, 2).map((repo) => repo.id)).toEqual(['runtime-row', 'ssh-row'])
    expect(observer).toHaveBeenCalledTimes(1)
    expect(observer).toHaveBeenCalledWith(repos[2])
  })
})
