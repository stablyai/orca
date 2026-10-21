import { describe, expect, it, vi } from 'vitest'
import {
  RuntimeProjectHostSetupController,
  SERVER_SSH_PROJECT_ADD_UNAVAILABLE_MESSAGE
} from './runtime-project-host-setup-controller'
import { getProjectHostSetupForRepo } from '../../shared/project-host-setup-lookup'
import { projectHostSetupProjectionFromRepos } from '../../shared/project-host-setup-projection'
import type { Repo } from '../../shared/repo-types'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'

const TARGET_ID = 'target-1'
const REPO_PATH = '/srv/app'

const repo: Repo = {
  id: 'repo-1',
  path: REPO_PATH,
  displayName: 'app',
  badgeColor: 'blue',
  addedAt: 1,
  kind: 'git'
}

function makeController(): {
  controller: RuntimeProjectHostSetupController
  addRepo: ReturnType<typeof vi.fn>
  cloneRepo: ReturnType<typeof vi.fn>
  removeProjectForHost: ReturnType<typeof vi.fn>
  projectId: string
} {
  const removeProjectForHost = vi.fn()
  const store = {
    removeProjectForHost,
    getProjects: () => projectHostSetupProjectionFromRepos([repo]).projects,
    getProjectHostSetups: () => [],
    updateRepo: (_target: unknown, updates: Record<string, unknown>) => ({ ...repo, ...updates })
  }
  const addRepo = vi.fn().mockResolvedValue(repo)
  const cloneRepo = vi.fn().mockResolvedValue(repo)
  const controller = new RuntimeProjectHostSetupController({
    getStore: () => store as never,
    listRepos: () => [repo],
    addRepo,
    cloneRepo,
    invalidateResolvedWorktrees: vi.fn(),
    invalidateWorktreeScan: vi.fn(),
    notifyReposChanged: vi.fn(),
    countLiveTerminalsForRepo: () => 0
  })
  return {
    controller,
    addRepo,
    cloneRepo,
    removeProjectForHost,
    projectId: getProjectHostSetupForRepo([], repo).projectId
  }
}

describe('RuntimeProjectHostSetupController host routing', () => {
  it('refuses an existing folder on an SSH target with the not-connected text, never locally', async () => {
    const { controller, addRepo, projectId } = makeController()

    const setup = controller.setupExistingFolder({
      projectId,
      hostId: `ssh:${TARGET_ID}`,
      path: REPO_PATH,
      kind: 'git'
    })

    await expect(setup).rejects.toThrow(SshHostNotServedError)
    await expect(setup).rejects.toThrow(`SSH connection "${TARGET_ID}" not found or not connected`)
    expect(addRepo).not.toHaveBeenCalled()
  })

  it('names the decoded connection id of a percent-encoded SSH target', async () => {
    const { controller, addRepo, projectId } = makeController()

    await expect(
      controller.setupExistingFolder({
        projectId,
        hostId: 'ssh:my%20host',
        path: REPO_PATH,
        kind: 'folder'
      })
    ).rejects.toThrow('SSH connection "my host" not found or not connected')
    expect(addRepo).not.toHaveBeenCalled()
  })

  it('refuses repo.addRemote by saying where the project can be added instead', () => {
    const { controller, addRepo } = makeController()

    expect(() => controller.addSshRepo({ connectionId: TARGET_ID })).toThrow(
      SERVER_SSH_PROJECT_ADD_UNAVAILABLE_MESSAGE
    )
    expect(addRepo).not.toHaveBeenCalled()
  })

  it('still uses the local registration for local and runtime hosts', async () => {
    const { controller, addRepo, projectId } = makeController()

    await controller.setupExistingFolder({
      projectId,
      hostId: 'local',
      path: REPO_PATH,
      kind: 'git'
    })

    expect(addRepo).toHaveBeenCalledWith(REPO_PATH, 'git', 'local', expect.any(Function))
  })

  it('refuses to clone onto an SSH host, because nothing here clones remotely', async () => {
    const { controller, cloneRepo, projectId } = makeController()

    await expect(
      controller.setupClone({
        projectId,
        hostId: `ssh:${TARGET_ID}`,
        url: 'https://example.com/app.git',
        destination: REPO_PATH
      })
    ).rejects.toThrow(/Cloning onto an SSH host is not supported/)
    expect(cloneRepo).not.toHaveBeenCalled()
  })
})

describe('RuntimeProjectHostSetupController new Git repository observer', () => {
  it('reports a repo the inner add created exactly once, after the setup is linked', async () => {
    const { controller, addRepo, projectId } = makeController()
    addRepo.mockImplementation(async (...args: unknown[]) => {
      const onNew = args[3]
      if (typeof onNew === 'function') {
        onNew(repo)
      }
      return repo
    })
    const observer = vi.fn()

    const result = await controller.setupExistingFolder(
      { projectId, hostId: 'local', path: REPO_PATH, kind: 'git' },
      observer
    )

    expect(observer).toHaveBeenCalledTimes(1)
    expect(observer).toHaveBeenCalledWith(result.repo)
  })

  it('does not report a repo the inner add reused, even if it was unknown to the snapshot', async () => {
    const { controller, projectId } = makeController()
    const observer = vi.fn()

    await controller.setupExistingFolder(
      { projectId, hostId: 'local', path: REPO_PATH, kind: 'git' },
      observer
    )

    expect(observer).not.toHaveBeenCalled()
  })

  it('does not report a registration whose setup could not be linked', async () => {
    const { controller, addRepo } = makeController()
    addRepo.mockImplementation(async (...args: unknown[]) => {
      const onNew = args[3]
      if (typeof onNew === 'function') {
        onNew(repo)
      }
      return repo
    })
    const observer = vi.fn()

    await expect(
      controller.setupExistingFolder(
        { projectId: 'github:acme/other', hostId: 'local', path: REPO_PATH, kind: 'git' },
        observer
      )
    ).rejects.toThrow('Imported folder does not match the selected project identity.')

    expect(observer).not.toHaveBeenCalled()
  })

  it('reports a clone the inner clone created exactly once', async () => {
    const { controller, cloneRepo, projectId } = makeController()
    cloneRepo.mockImplementation(async (...args: unknown[]) => {
      const onNew = args[3]
      if (typeof onNew === 'function') {
        onNew(repo)
      }
      return repo
    })
    const observer = vi.fn()

    await controller.setupClone(
      { projectId, hostId: 'local', url: 'https://example.com/app.git', destination: '/srv' },
      observer
    )

    expect(observer).toHaveBeenCalledTimes(1)
  })

  it('does not report a clone that reused a saved project', async () => {
    const { controller, projectId } = makeController()
    const observer = vi.fn()

    await controller.setupClone(
      { projectId, hostId: 'local', url: 'https://example.com/app.git', destination: '/srv' },
      observer
    )

    expect(observer).not.toHaveBeenCalled()
  })
})

describe('RuntimeProjectHostSetupController rollback ownership', () => {
  const mismatched = (projectId: string, kind: 'git' | 'folder' = 'git') => ({
    projectId: `github:acme/${projectId}`,
    hostId: 'local' as const,
    path: REPO_PATH,
    kind
  })
  const announceInsertion =
    (inserted: Repo) =>
    async (...args: unknown[]): Promise<Repo> => {
      const onInserted = args[3]
      if (typeof onInserted === 'function') {
        onInserted(inserted)
      }
      return inserted
    }

  it('keeps a row a concurrent registration committed after the call began', async () => {
    const { controller, addRepo, removeProjectForHost } = makeController()
    // The concurrent winner is absent from listRepos at call start and is returned, not inserted, here.
    addRepo.mockResolvedValue({ ...repo, id: 'concurrent-winner' })
    const observer = vi.fn()

    await expect(controller.setupExistingFolder(mismatched('other'), observer)).rejects.toThrow()

    expect(removeProjectForHost).not.toHaveBeenCalled()
    expect(observer).not.toHaveBeenCalled()
  })

  it('rolls back a Git row this call inserted when linking fails', async () => {
    const { controller, addRepo, removeProjectForHost } = makeController()
    addRepo.mockImplementation(announceInsertion(repo))

    await expect(controller.setupExistingFolder(mismatched('other'))).rejects.toThrow()

    expect(removeProjectForHost).toHaveBeenCalledWith(repo)
  })

  it('rolls back a folder row this call inserted when linking fails', async () => {
    const { controller, addRepo, removeProjectForHost } = makeController()
    const folder: Repo = { ...repo, id: 'folder-1', kind: 'folder' }
    addRepo.mockImplementation(announceInsertion(folder))

    await expect(controller.setupExistingFolder(mismatched('other', 'folder'))).rejects.toThrow()

    expect(removeProjectForHost).toHaveBeenCalledWith(folder)
  })

  it('keeps a known row it merely reused when linking fails', async () => {
    const { controller, removeProjectForHost } = makeController()

    await expect(controller.setupExistingFolder(mismatched('other'))).rejects.toThrow()

    expect(removeProjectForHost).not.toHaveBeenCalled()
  })

  it('rolls back a clone this call inserted, and keeps a reused clone, when linking fails', async () => {
    const { controller, cloneRepo, removeProjectForHost } = makeController()
    const cloneArgs = {
      ...mismatched('other'),
      url: 'https://example.com/app.git',
      destination: '/srv'
    }

    await expect(controller.setupClone(cloneArgs)).rejects.toThrow()
    expect(removeProjectForHost).not.toHaveBeenCalled()

    cloneRepo.mockImplementation(announceInsertion(repo))
    await expect(controller.setupClone(cloneArgs)).rejects.toThrow()
    expect(removeProjectForHost).toHaveBeenCalledWith(repo)
  })
})
