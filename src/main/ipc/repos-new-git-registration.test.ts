import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as GitRunner from '../git/runner'
import type * as RepoModule from '../git/repo'
import type { Repo } from '../../shared/repo-types'

const { reposMocks, moduleMocks, detectMock } = await vi.hoisted(async () => {
  const moduleMocks = await import('./repos-remote-test-harness')
  return {
    reposMocks: moduleMocks.createReposIpcMocks(),
    moduleMocks,
    detectMock: vi.fn()
  }
})

vi.mock('electron', () => moduleMocks.electronModuleMock(reposMocks))
vi.mock('../git/repo', async (importOriginal) =>
  moduleMocks.gitRepoModuleMock(await importOriginal<typeof RepoModule>())
)
vi.mock('../git/runner', async (importOriginal) =>
  moduleMocks.gitRunnerModuleMock(reposMocks, await importOriginal<typeof GitRunner>())
)
vi.mock('../git/worktree', () => moduleMocks.gitWorktreeModuleMock(reposMocks))
vi.mock('./registered-worktree-roots-cache', () =>
  moduleMocks.registeredWorktreeRootsCacheModuleMock(reposMocks)
)
vi.mock('../worktree-root-preparation', () =>
  moduleMocks.worktreeRootPreparationModuleMock(reposMocks)
)
vi.mock('../repo-icon-autodetect', () => ({ detectRepoIconAndUpstream: detectMock }))

import { registerRepoHandlers } from './repos'
import { clearGitCapabilityStateForTests } from '../git/git-capability-state'
import { resetSshProviderAuthorities } from '../ssh/ssh-provider-authority'
import { isGitRepo } from '../git/repo'
import { createRepoHandlerHarness, resetLocalRepoMocks } from './repos-remote-test-harness'

const { handleMock, mockStore, gitExecFileAsyncMock } = reposMocks

function competitor(path: string): Repo {
  return {
    id: 'competitor',
    path,
    displayName: 'competitor',
    badgeColor: '#22c55e',
    addedAt: 1,
    kind: 'git'
  }
}

function foreignRows(path: string): Repo[] {
  return [
    { ...competitor(path), id: 'runtime-row', executionHostId: 'runtime:env-1' },
    { ...competitor(path), id: 'ssh-row', connectionId: 'ssh-1' }
  ]
}

describe('local IPC registration dedupe and race handling', () => {
  const { handlers, mockWindow, captureHandlers } = createRepoHandlerHarness()
  const roots: string[] = []
  let repos: Repo[]

  const makeRoot = async (): Promise<string> => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-new-git-registration-')))
    roots.push(root)
    return root
  }

  beforeEach(() => {
    clearGitCapabilityStateForTests()
    resetSshProviderAuthorities()
    captureHandlers(handleMock)
    resetLocalRepoMocks(reposMocks)
    mockWindow.webContents.send.mockReset()
    detectMock.mockReset().mockResolvedValue({})
    gitExecFileAsyncMock.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
    repos = []
    mockStore.getRepos.mockImplementation(() => repos)
    mockStore.addRepo.mockImplementation((repo: Repo) => repos.push(repo))
    mockStore.removeProjectForHost.mockImplementation((repo: Repo) => {
      repos = repos.filter((candidate) => candidate.id !== repo.id)
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers only touch the window, store and runtime members these fakes define.
    registerRepoHandlers(mockWindow as never, mockStore as never, {} as never)
  })

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  describe('repos:add', () => {
    it('registers a new Git repo once, reuses a reopen, and adds a folder separately', async () => {
      await handlers.get('repos:add')!(null, { path: '/tmp/new-git', kind: 'git' })
      await handlers.get('repos:add')!(null, { path: '/tmp/new-git', kind: 'git' })
      await handlers.get('repos:add')!(null, { path: '/tmp/new-folder', kind: 'folder' })

      expect(repos.map((repo) => [repo.path, repo.kind])).toEqual([
        ['/tmp/new-git', 'git'],
        ['/tmp/new-folder', 'folder']
      ])
    })
  })

  describe('repos:create', () => {
    it('creates a Git repo once, reuses a repeat create, and adds a folder separately', async () => {
      const root = await makeRoot()
      const args = { parentPath: root, name: 'made', kind: 'git' }

      await handlers.get('repos:create')!(null, args)
      await handlers.get('repos:create')!(null, args)
      await handlers.get('repos:create')!(null, { ...args, name: 'notes', kind: 'folder' })

      expect(repos.map((repo) => repo.kind)).toEqual(['git', 'folder'])
    })

    it('keeps only the winner when another registration lands during icon discovery', async () => {
      const root = await makeRoot()
      detectMock.mockImplementationOnce(async () => {
        repos.push(competitor(join(root, 'raced')))
        return {}
      })

      const result = await handlers.get('repos:create')!(null, {
        parentPath: root,
        name: 'raced',
        kind: 'git'
      })

      expect(result).toMatchObject({ repo: { id: 'competitor' } })
      expect(repos).toHaveLength(1)
    })
  })

  describe('foreign-host rows landing during icon discovery', () => {
    it('repos:create still registers its own local row', async () => {
      const root = await makeRoot()
      detectMock.mockImplementationOnce(async () => {
        repos.push(...foreignRows(join(root, 'made')))
        return {}
      })

      const result = await handlers.get('repos:create')!(null, {
        parentPath: root,
        name: 'made',
        kind: 'git'
      })

      expect(repos.map((repo) => repo.id).slice(0, 2)).toEqual(['runtime-row', 'ssh-row'])
      expect(repos).toHaveLength(3)
      expect(result).toMatchObject({ repo: { id: repos[2].id, path: join(root, 'made') } })
    })

    it('projectGroups:importNested still imports its own local row', async () => {
      const root = await makeRoot()
      await mkdir(join(root, 'api', '.git'), { recursive: true })
      vi.mocked(isGitRepo).mockImplementation((path: string) => path !== root)
      mockStore.createProjectGroup.mockReturnValue({ id: 'group-1', name: 'Group' })
      detectMock.mockImplementationOnce(async () => {
        repos.push(...foreignRows(join(root, 'api')))
        return {}
      })

      const result = await handlers.get('projectGroups:importNested')!(null, {
        parentPath: root,
        groupName: 'Group',
        projectPaths: [join(root, 'api')],
        mode: 'group'
      })

      expect(result).toMatchObject({ importedCount: 1, alreadyKnownCount: 0 })
      expect(repos).toHaveLength(3)
    })
  })

  describe('repos:clone', () => {
    it('registers a fresh clone once', async () => {
      const destination = await makeRoot()

      await handlers.get('repos:clone')!(null, { url: 'https://example.com/orca.git', destination })

      expect(repos.map((repo) => repo.kind)).toEqual(['git'])
    })

    it('adds no row when a saved project is reused after its folder was cloned again', async () => {
      const destination = await makeRoot()
      const clonePath = join(destination, 'orca')
      repos.push({
        ...competitor(clonePath),
        gitRemoteIdentity: {
          canonicalKey: 'example.com/orca',
          remoteName: 'origin',
          remoteUrl: 'https://example.com/orca.git'
        }
      })
      gitExecFileAsyncMock.mockRejectedValue(new Error('spawn ENOENT'))

      await handlers.get('repos:clone')!(null, {
        url: 'https://example.com/orca.git',
        destination
      })

      expect(repos).toHaveLength(1)
    })

    it('adds no row when the clone turns a saved folder project into a Git project', async () => {
      const destination = await makeRoot()
      const clonePath = join(destination, 'orca')
      repos.push({ ...competitor(clonePath), kind: 'folder' })
      mockStore.updateRepo.mockImplementation((_target: { id: string }, updates: object) => {
        repos[0] = { ...repos[0], ...updates }
        return repos[0]
      })

      await handlers.get('repos:clone')!(null, {
        url: 'https://example.com/orca.git',
        destination
      })

      expect(repos).toHaveLength(1)
      expect(repos[0].kind).toBe('git')
    })

    it('adds no row when another registration lands during icon discovery', async () => {
      const destination = await makeRoot()
      detectMock.mockImplementationOnce(async () => {
        repos.push(competitor(join(destination, 'orca')))
        return {}
      })

      const result = await handlers.get('repos:clone')!(null, {
        url: 'https://example.com/orca.git',
        destination
      })

      expect(result).toMatchObject({ id: 'competitor' })
      expect(repos).toHaveLength(1)
      expect(mockStore.addRepo).not.toHaveBeenCalled()
      expect(reposMocks.prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(
        mockStore,
        repos[0]
      )
      expect(reposMocks.invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
      expect(mockWindow.webContents.send).toHaveBeenCalledWith('repos:changed')
    })
  })

  describe('projectGroups:importNested', () => {
    const importArgs = (root: string, dirs: string[]) => ({
      parentPath: root,
      groupName: 'Group',
      projectPaths: dirs.map((dir) => join(root, dir)),
      mode: 'group'
    })

    async function withTree(run: (root: string) => Promise<void>): Promise<void> {
      const root = await makeRoot()
      await mkdir(join(root, 'api', '.git'), { recursive: true })
      await mkdir(join(root, 'web', '.git'), { recursive: true })
      vi.mocked(isGitRepo).mockImplementation((path: string) => path !== root)
      mockStore.createProjectGroup.mockReturnValue({ id: 'group-1', name: 'Group' })
      await run(root)
    }

    it('imports only the new repo and leaves an already-known one', async () => {
      await withTree(async (root) => {
        repos.push(competitor(join(root, 'api')))

        const result = await handlers.get('projectGroups:importNested')!(
          null,
          importArgs(root, ['api', 'web'])
        )

        expect(result).toMatchObject({ importedCount: 1, alreadyKnownCount: 1 })
        expect(repos).toHaveLength(2)
        expect(repos[1].path).toBe(join(root, 'web'))
      })
    })

    it('registers a local row when only another host tracks that path', async () => {
      await withTree(async (root) => {
        repos.push(...foreignRows(join(root, 'api')))

        const result = await handlers.get('projectGroups:importNested')!(
          null,
          importArgs(root, ['api'])
        )

        expect(result).toMatchObject({ importedCount: 1, alreadyKnownCount: 0 })
        expect(repos).toHaveLength(3)
        expect(repos[2].path).toBe(join(root, 'api'))
        expect(repos[2].executionHostId).toBeUndefined()
      })
    })

    it('keeps a repo another registration added during icon discovery', async () => {
      await withTree(async (root) => {
        detectMock.mockImplementationOnce(async () => {
          repos.push(competitor(join(root, 'api')))
          return {}
        })

        const result = await handlers.get('projectGroups:importNested')!(
          null,
          importArgs(root, ['api'])
        )

        expect(result).toMatchObject({ importedCount: 0, alreadyKnownCount: 1 })
        expect(repos).toHaveLength(1)
      })
    })
  })

  describe('projectHostSetups:setupExistingFolder', () => {
    const setupArgs = {
      projectId: 'project-1',
      hostId: 'local',
      path: '/tmp/setup-new',
      kind: 'git'
    }

    function linkProject(): void {
      mockStore.getProjects.mockReturnValue([{ id: 'project-1', displayName: 'Project' }])
      mockStore.getProjectHostSetups.mockImplementation(() =>
        repos.map((repo) => ({
          id: repo.id,
          projectId: 'project-1',
          repoId: repo.id,
          hostId: 'local',
          path: repo.path,
          displayName: repo.displayName,
          setupState: 'ready',
          setupMethod: 'imported-existing-folder'
        }))
      )
      mockStore.updateRepo.mockImplementation((target: { id: string }, updates: object) => {
        const index = repos.findIndex((repo) => repo.id === target.id)
        repos[index] = { ...repos[index], ...updates }
        return repos[index]
      })
    }

    it('registers the new repo once', async () => {
      linkProject()

      await handlers.get('projectHostSetups:setupExistingFolder')!(null, setupArgs)

      expect(repos).toHaveLength(1)
    })

    it('reuses a known repo', async () => {
      repos.push({ ...competitor('/tmp/setup-new'), id: 'known' })
      linkProject()

      await handlers.get('projectHostSetups:setupExistingFolder')!(null, setupArgs)

      expect(repos.map((repo) => repo.id)).toEqual(['known'])
    })

    it('rolls back a registration whose setup fails', async () => {
      await expect(
        handlers.get('projectHostSetups:setupExistingFolder')!(null, {
          ...setupArgs,
          projectId: 'github:acme/orca',
          projectProviderIdentity: { provider: 'github', owner: 'other', repo: 'orca' }
        })
      ).rejects.toThrow('Imported folder does not match the selected project identity.')

      expect(repos).toHaveLength(0)
    })
  })
})
