import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from '../git/runner'
import type * as RepoModule from '../git/repo'

const { reposMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./repos-remote-test-harness')
  return { reposMocks: moduleMocks.createReposIpcMocks(), moduleMocks }
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
vi.mock('../providers/ssh-git-dispatch', () => moduleMocks.sshGitDispatchModuleMock(reposMocks))
vi.mock('../providers/ssh-filesystem-dispatch', () =>
  moduleMocks.sshFilesystemDispatchModuleMock(reposMocks)
)
vi.mock('./ssh', () => moduleMocks.sshModuleMock(reposMocks))

import { registerRepoHandlers } from './repos'
import { clearGitCapabilityStateForTests } from '../git/git-capability-state'
import { resetSshProviderAuthorities } from '../ssh/ssh-provider-authority'
import { getGitRepoRoot } from '../git/repo'
import { DEFAULT_REPO_BADGE_COLOR } from '../../shared/constants'
import { createRepoHandlerHarness, resetLocalRepoMocks } from './repos-remote-test-harness'

const {
  handleMock,
  mockStore,
  invalidateAuthorizedRootsCacheMock,
  prepareLocalWorktreeRootForRepoMock
} = reposMocks

beforeEach(() => {
  clearGitCapabilityStateForTests()
  resetSshProviderAuthorities()
})

describe('repos:add + repos:clone', () => {
  const { handlers, mockWindow, captureHandlers } = createRepoHandlerHarness()

  beforeEach(() => {
    captureHandlers(handleMock)
    resetLocalRepoMocks(reposMocks)
    mockWindow.webContents.send.mockReset()

    registerRepoHandlers(mockWindow as never, mockStore as never)
  })

  it('defaults repos:add badgeColor to DEFAULT_REPO_BADGE_COLOR for folder repos', async () => {
    const result = await handlers.get('repos:add')!(null, { path: '/tmp/from-add', kind: 'folder' })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/tmp/from-add', badgeColor: DEFAULT_REPO_BADGE_COLOR })
    )
    expect(result).toHaveProperty('repo.badgeColor', DEFAULT_REPO_BADGE_COLOR)
  })

  it('inherits global non-Orca visibility while retaining the mixed-version safety marker', async () => {
    const result = await handlers.get('repos:add')!(null, { path: '/tmp/from-add', kind: 'git' })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/tmp/from-add',
        kind: 'git',
        externalWorktreeVisibilityLegacy: false,
        projectHostSetupMethod: 'imported-existing-folder'
      })
    )
    expect(result).not.toHaveProperty('repo.externalWorktreeVisibility')
    expect(result).toHaveProperty('repo.externalWorktreeVisibilityLegacy', false)
  })

  it('prepares the worktree root when adding a local git repo', async () => {
    await handlers.get('repos:add')!(null, { path: '/tmp/from-add', kind: 'git' })

    expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(
      mockStore,
      expect.objectContaining({ path: '/tmp/from-add', kind: 'git' })
    )
  })

  it('canonicalizes local git repos:add to the detected root path', async () => {
    vi.mocked(getGitRepoRoot).mockReturnValue('/tmp/from-add')

    const result = await handlers.get('repos:add')!(null, {
      path: '/tmp/from-add/packages/web',
      kind: 'git'
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/tmp/from-add',
        displayName: 'from-add'
      })
    )
    expect(result).toHaveProperty('repo.path', '/tmp/from-add')
  })

  it('dedupes local git repos:add after canonical root resolution', async () => {
    const existing = {
      id: 'repo-add-existing-root',
      path: '/tmp/from-add',
      displayName: 'from-add',
      kind: 'git',
      badgeColor: '#22c55e'
    }
    mockStore.getRepos.mockReturnValue([existing])
    vi.mocked(getGitRepoRoot).mockReturnValue('/tmp/from-add')

    const result = await handlers.get('repos:add')!(null, {
      path: '/tmp/from-add/packages/web',
      kind: 'git'
    })

    expect(result).toEqual({ repo: existing })
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('returns existing badgeColor unchanged on repos:add dedupe', async () => {
    const existing = {
      id: 'repo-add-existing',
      path: '/tmp/from-add-existing',
      displayName: 'from-add-existing',
      kind: 'folder',
      badgeColor: '#22c55e',
      externalWorktreeVisibility: 'show'
    }
    mockStore.getRepos.mockReturnValue([existing])

    const result = await handlers.get('repos:add')!(null, {
      path: '/tmp/from-add-existing',
      kind: 'folder'
    })

    expect(result).toEqual({ repo: existing })
    expect(result).toHaveProperty('repo.badgeColor', '#22c55e')
    expect(result).toHaveProperty('repo.externalWorktreeVisibility', 'show')
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('prepares the worktree root when repos:add returns an existing local git repo', async () => {
    const existing = {
      id: 'repo-add-existing-git',
      path: '/tmp/from-add-existing-git',
      displayName: 'from-add-existing-git',
      kind: 'git',
      badgeColor: '#22c55e'
    }
    mockStore.getRepos.mockReturnValue([existing])

    await handlers.get('repos:add')!(null, {
      path: '/tmp/from-add-existing-git',
      kind: 'git'
    })

    expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(mockStore, existing)
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('prepares the aligned worktree root when project setup uses an existing local git repo', async () => {
    const existing = {
      id: 'repo-setup-existing-git',
      path: '/tmp/from-setup-existing-git',
      displayName: 'from-setup-existing-git',
      kind: 'git',
      badgeColor: '#22c55e'
    }
    const aligned = { ...existing, projectHostSetupMethod: 'imported-existing-folder' }
    const project = { id: 'project-1', displayName: 'Project' }
    const setup = {
      id: 'setup-1',
      projectId: project.id,
      repoId: existing.id,
      hostId: 'local',
      path: existing.path,
      displayName: existing.displayName,
      setupState: 'ready',
      setupMethod: 'imported-existing-folder'
    }
    mockStore.getRepos.mockReturnValue([existing])
    mockStore.getProjects.mockReturnValue([project])
    mockStore.getProjectHostSetups.mockReturnValue([setup])
    mockStore.updateRepo.mockReturnValue(aligned)

    await handlers.get('projectHostSetups:setupExistingFolder')!(null, {
      projectId: project.id,
      hostId: 'local',
      path: existing.path,
      kind: 'git',
      setupMethod: 'imported-existing-folder'
    })

    expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(mockStore, aligned)
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('preserves the selected Enterprise host when aligning an existing folder', async () => {
    const existing = {
      id: 'repo-setup-enterprise',
      path: '/tmp/from-setup-enterprise',
      displayName: 'from-setup-enterprise',
      kind: 'git',
      badgeColor: '#22c55e'
    }
    const existingProject = { id: 'repo:repo-setup-enterprise', displayName: 'Existing' }
    const selectedProject = {
      id: 'github:github.acme-corp.com/acme/orca',
      displayName: 'Enterprise project',
      providerIdentity: {
        provider: 'github',
        owner: 'acme',
        repo: 'orca',
        host: 'github.acme-corp.com'
      }
    }
    const setup = {
      id: existing.id,
      projectId: existingProject.id,
      repoId: existing.id,
      hostId: 'local',
      path: existing.path,
      displayName: existing.displayName,
      setupState: 'ready',
      setupMethod: 'legacy-repo'
    }
    let updatedRepo = existing
    mockStore.getRepos.mockReturnValue([existing])
    mockStore.getProjects.mockReturnValue([existingProject, selectedProject])
    mockStore.getProjectHostSetups.mockReturnValue([setup])
    mockStore.updateRepo.mockImplementation((_repoId, updates) => {
      updatedRepo = { ...updatedRepo, ...updates }
      return updatedRepo
    })

    await handlers.get('projectHostSetups:setupExistingFolder')!(null, {
      projectId: selectedProject.id,
      hostId: 'local',
      path: existing.path,
      kind: 'git',
      setupMethod: 'imported-existing-folder'
    })

    expect(mockStore.updateRepo).toHaveBeenNthCalledWith(1, existing.id, {
      upstream: {
        owner: 'acme',
        repo: 'orca',
        host: 'github.acme-corp.com'
      }
    })
  })

  it('sets up a folder when the selected project exists only on another host', async () => {
    const added: Record<string, unknown>[] = []
    mockStore.getRepos.mockImplementation(() => added)
    mockStore.addRepo.mockImplementation((repo: Record<string, unknown>) => added.push(repo))
    mockStore.updateRepo.mockImplementation((id, updates) => {
      const repo = added.find((entry) => entry.id === id)
      if (!repo) {
        return null
      }
      Object.assign(repo, updates)
      return { ...repo }
    })
    mockStore.getProjects.mockImplementation(() => {
      const repo = added.find((entry) => 'upstream' in entry)
      return repo
        ? [
            {
              id: 'github:github.acme.test/acme/orca',
              displayName: 'Orca',
              providerIdentity: {
                provider: 'github',
                owner: 'acme',
                repo: 'orca',
                host: 'github.acme.test'
              }
            }
          ]
        : []
    })

    const result = await handlers.get('projectHostSetups:setupExistingFolder')!(null, {
      projectId: 'github:github.acme.test/acme/orca',
      projectProviderIdentity: {
        provider: 'github',
        owner: 'acme',
        repo: 'orca',
        host: 'github.acme.test'
      },
      hostId: 'local',
      path: '/tmp/orca-local',
      kind: 'git'
    })

    expect(added[0]?.upstream).toEqual({
      owner: 'acme',
      repo: 'orca',
      host: 'github.acme.test'
    })
    expect(result).toHaveProperty('project.id', 'github:github.acme.test/acme/orca')
  })

  it('rolls back a new repo when the supplied identity does not match the project', async () => {
    const added: Record<string, unknown>[] = []
    mockStore.getRepos.mockImplementation(() => added)
    mockStore.addRepo.mockImplementation((repo: Record<string, unknown>) => added.push(repo))

    await expect(
      handlers.get('projectHostSetups:setupExistingFolder')!(null, {
        projectId: 'github:acme/orca',
        projectProviderIdentity: { provider: 'github', owner: 'other', repo: 'orca' },
        hostId: 'local',
        path: '/tmp/mismatched-project',
        kind: 'git'
      })
    ).rejects.toThrow('Imported folder does not match the selected project identity.')

    expect(mockStore.removeProject).toHaveBeenCalledWith(added[0]?.id)
    expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
  })

  it('prepares and invalidates roots when repos:update changes worktree base path', () => {
    const updated = {
      id: 'repo-update-root',
      path: '/tmp/repo-update-root',
      displayName: 'repo-update-root',
      kind: 'git',
      badgeColor: '#22c55e',
      worktreeBasePath: '../worktrees'
    }
    mockStore.updateRepo.mockReturnValue(updated)

    const result = handlers.get('repos:update')!(null, {
      repoId: updated.id,
      updates: { worktreeBasePath: ' ../worktrees ' }
    })

    expect(result).toBe(updated)
    expect(mockStore.updateRepo).toHaveBeenCalledWith(updated.id, {
      worktreeBasePath: '../worktrees'
    })
    expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(mockStore, updated)
    expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
  })

  it('persists agent worktree visibility through local repos:update', () => {
    const updated = {
      id: 'repo-agent-visibility',
      path: '/tmp/repo-agent-visibility',
      displayName: 'repo-agent-visibility',
      kind: 'git',
      badgeColor: '#22c55e',
      agentWorktreeVisibility: 'show'
    }
    mockStore.updateRepo.mockReturnValue(updated)

    const result = handlers.get('repos:update')!(null, {
      repoId: updated.id,
      updates: { agentWorktreeVisibility: 'show' }
    })

    expect(result).toBe(updated)
    expect(mockStore.updateRepo).toHaveBeenCalledWith(updated.id, {
      agentWorktreeVisibility: 'show'
    })
  })

  it('validates source definitions and preferences through local repos:update', () => {
    const updated = {
      id: 'repo-source-visibility',
      path: '/tmp/repo-source-visibility',
      displayName: 'repo-source-visibility',
      kind: 'git',
      badgeColor: '#22c55e'
    }
    mockStore.updateRepo.mockReturnValue(updated)

    handlers.get('repos:update')!(null, {
      repoId: updated.id,
      updates: {
        customWorktreeVisibilitySources: [
          { id: 'team', rootPath: ' /srv/team ' },
          { id: 'bad id', rootPath: '/srv/other' }
        ],
        worktreeVisibilitySourcePreferences: {
          builtIn: { claude: 'show', gsd: 'invalid' },
          custom: { team: 'hide' }
        }
      }
    })

    expect(mockStore.updateRepo).toHaveBeenCalledWith(updated.id, {
      customWorktreeVisibilitySources: [{ id: 'team', rootPath: '/srv/team' }],
      worktreeVisibilitySourcePreferences: {
        builtIn: { claude: 'show' },
        custom: { team: 'hide' }
      }
    })
  })

  it('prepares and invalidates roots when project host setup update changes worktree base path', () => {
    const repo = {
      id: 'repo-setup-update-root',
      path: '/tmp/repo-setup-update-root',
      displayName: 'repo-setup-update-root',
      kind: 'git',
      badgeColor: '#22c55e',
      worktreeBasePath: '../worktrees'
    }
    const result = {
      project: { id: 'project-1', displayName: 'Project' },
      setup: { id: 'setup-1', projectId: 'project-1', repoId: repo.id, hostId: 'local' },
      repo
    }
    mockStore.updateProjectHostSetup.mockReturnValue(result)

    expect(
      handlers.get('projectHostSetups:update')!(null, {
        setupId: 'setup-1',
        updates: { worktreeBasePath: '../worktrees' }
      })
    ).toBe(result)

    expect(prepareLocalWorktreeRootForRepoMock).toHaveBeenCalledWith(mockStore, repo)
    expect(invalidateAuthorizedRootsCacheMock).toHaveBeenCalled()
  })

  it('dedupes repos:add by normalized local path on Windows', async () => {
    const existing = {
      id: 'repo-add-windows-existing',
      path: 'C:\\Users\\Ava\\Repo',
      displayName: 'Repo',
      kind: 'folder',
      badgeColor: '#22c55e'
    }
    mockStore.getRepos.mockReturnValue([existing])

    const result = await handlers.get('repos:add')!(null, {
      path: 'c:/Users/Ava/Repo',
      kind: 'folder'
    })

    expect(result).toEqual({ repo: existing })
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })
})
