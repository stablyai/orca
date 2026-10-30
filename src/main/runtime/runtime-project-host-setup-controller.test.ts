import { describe, expect, it, vi } from 'vitest'
import { RuntimeProjectHostSetupController } from './runtime-project-host-setup-controller'
import { SERVER_SSH_PROJECT_ADD_UNAVAILABLE_MESSAGE } from '../../shared/project-host-setup-target'
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
  projectId: string
} {
  const store = {
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
    await expect(setup).rejects.toThrow(SERVER_SSH_PROJECT_ADD_UNAVAILABLE_MESSAGE)
    expect(addRepo).not.toHaveBeenCalled()
  })

  it('preserves the decoded connection id when refusing a percent-encoded SSH target', async () => {
    const { controller, addRepo, projectId } = makeController()

    await expect(
      controller.setupExistingFolder({
        projectId,
        hostId: 'ssh:my%20host',
        path: REPO_PATH,
        kind: 'folder'
      })
    ).rejects.toMatchObject({
      code: 'ssh_host_not_served',
      connectionId: 'my host',
      message: SERVER_SSH_PROJECT_ADD_UNAVAILABLE_MESSAGE
    })
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

    expect(addRepo).toHaveBeenCalledWith(REPO_PATH, 'git', 'local')
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
