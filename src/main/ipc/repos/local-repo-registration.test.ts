import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { Store } from '../../persistence/loading-store/store'
import type * as WslMappedDriveModule from '../../wsl/filesystem/wsl-mapped-drive-path'
import { addLocalRepoFromPath } from './local-repo-registration'

vi.mock('../../repository-icons/repo-icon-autodetect', () => ({
  detectRepoIconAndUpstream: vi.fn().mockResolvedValue({})
}))
vi.mock('../../workspaces/creation/worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('../../wsl/filesystem/wsl-mapped-drive-path', async (importOriginal) => {
  const actual = await importOriginal<typeof WslMappedDriveModule>()
  return {
    resolveWslMappedDrivePath: (path: string) =>
      actual.resolveWslMappedDrivePath(
        path,
        'win32',
        async () => String.raw`\\wsl.localhost\Ubuntu\home\dev\repo`
      )
  }
})
vi.mock('../../git/runner', () => ({
  awaitWindowsHostGitEnvironmentReady: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('../../git/repo', () => ({
  inspectGitRepoForRegistrationAsync: vi.fn(async (path: string) => {
    if (path !== String.raw`\\wsl.localhost\Ubuntu\home\dev\repo`) {
      throw new Error('Mapped drive reached Git without WSL resolution')
    }
    return { isRepo: true, rootPath: path, mainRepoPath: null }
  }),
  getGitRepoRootAsync: vi.fn(),
  getRepoName: () => 'repo'
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

  it('registers a mapped WSL repository at its UNC path before probing Git', async () => {
    const repos: Repo[] = []
    await addLocalRepoFromPath(createStore(repos), String.raw`W:\home\dev\repo`)
    expect(repos).toMatchObject([
      { path: String.raw`\\wsl.localhost\Ubuntu\home\dev\repo`, kind: 'git' }
    ])
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
