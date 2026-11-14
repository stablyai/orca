import { runProcessSync } from '@orca/process-host'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceDir } from '../../../shared/constants'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import type { Repo } from '../../../shared/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { RuntimeStore } from '../construction/runtime-store-contract'
import { RuntimeRepositoryRegistrationController } from './runtime-repository-registration-controller'
import { partialRuntimeStore } from '../orca-runtime-tests/runtime-store-partial-fixture'

vi.mock('../../repository-icons/repo-icon-autodetect', () => ({
  detectRepoLocalMetadata: vi.fn().mockResolvedValue({})
}))
vi.mock('../../workspaces/creation/worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn().mockResolvedValue(undefined)
}))

const dirLinkType = process.platform === 'win32' ? 'junction' : 'dir'

function createController(): {
  controller: RuntimeRepositoryRegistrationController
  repos: Repo[]
} {
  const repos: Repo[] = []
  const store = partialRuntimeStore({
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    addRepo: (repo: Repo) => {
      repos.push(repo)
      return repo
    },
    updateRepo: () => null
  })
  const controller = new RuntimeRepositoryRegistrationController({
    getStore: () => store,
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

const repoAt = (path: string): Repo => ({
  id: `repo-${path}`,
  path,
  displayName: path.split('/').pop() ?? path,
  badgeColor: '#aabbcc',
  addedAt: 0,
  kind: 'git'
})

// Type-correct filler: no test below reaches the work that would write meta.
const emptyWorktreeMeta = (): WorktreeMeta => ({
  displayName: '',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
})

// Minimal RuntimeStore: `create` reads repos and settings only until the target
// directory work begins, and every test below returns from the dedup check.
const makeStore = (repos: Repo[], workspaceDir: string): RuntimeStore => ({
  getRepos: () => repos,
  getRepo: () => undefined,
  addRepo: () => {},
  updateRepo: () => null,
  getAllWorktreeMeta: () => ({}),
  getWorktreeMeta: () => undefined,
  setWorktreeMeta: () => emptyWorktreeMeta(),
  removeWorktreeMeta: () => {},
  getGitHubCache: () => ({ pr: {}, issue: {} }),
  getSettings: () => ({
    workspaceDir,
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: '',
    branchPrefixCustom: ''
  })
})

const makeController = (
  repos: Repo[],
  workspaceDir: string
): RuntimeRepositoryRegistrationController =>
  new RuntimeRepositoryRegistrationController({
    getStore: () => makeStore(repos, workspaceDir),
    invalidateResolvedWorktrees: () => {},
    invalidateWorktreeScan: () => {},
    notifyReposChanged: () => {}
  })

describe('RuntimeRepositoryRegistrationController default create parent', () => {
  // Each case proves the resolved parent through the dedup-by-target-path hit:
  // `create` returns the existing row only when parent + name match its path.

  it('uses a workspace directory the user actually chose when parentPath is absent', async () => {
    const existing = repoAt('/srv/chosen/new-app')
    const controller = makeController([existing], '/srv/chosen')

    await expect(controller.create(undefined, 'new-app', 'git')).resolves.toEqual({
      repo: existing
    })
  })

  it('treats a blank parentPath as absent', async () => {
    const existing = repoAt('/srv/chosen/new-app')
    const controller = makeController([existing], '/srv/chosen')

    await expect(controller.create('   ', 'new-app', 'git')).resolves.toEqual({
      repo: existing
    })
  })

  it('ignores the untouched seeded default and falls back to the home projects directory', async () => {
    const existing = repoAt(join(homedir(), 'orca', 'projects', 'new-app'))
    const controller = makeController([existing], getDefaultWorkspaceDir(homedir()))

    await expect(controller.create(undefined, 'new-app', 'git')).resolves.toEqual({
      repo: existing
    })
  })

  it('honors an explicit parent over the default', async () => {
    const defaultRow = repoAt(join(homedir(), 'orca', 'projects', 'new-app'))
    const explicitRow = repoAt('/srv/custom/new-app')
    const controller = makeController([defaultRow, explicitRow], getDefaultWorkspaceDir(homedir()))

    await expect(controller.create('/srv/custom', 'new-app', 'git')).resolves.toEqual({
      repo: explicitRow
    })
  })

  it('still rejects a non-absolute parent', async () => {
    const controller = makeController([], '/srv/chosen')

    await expect(controller.create('relative/path', 'new-app', 'git')).resolves.toEqual({
      error: 'Parent directory must be an absolute path',
      errorCode: 'parentNotAbsolute'
    })
  })
})
