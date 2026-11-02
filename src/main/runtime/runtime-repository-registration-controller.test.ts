import { runProcessSync } from '@orca/process-host'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { RuntimeRepositoryRegistrationController } from './runtime-repository-registration-controller'
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
