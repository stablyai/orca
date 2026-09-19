// The CLI/runtime RPC used to refuse `--host ssh:*` with "set the project up from the Orca desktop
// app" — while the desktop IPC handler in the *same process* routed it correctly through
// addRemoteRepoFromPath. Safe but wrong: the process refusing is the one that owns the connection.
import { describe, expect, it, vi } from 'vitest'
import { RuntimeProjectHostSetupController } from './runtime-project-host-setup-controller'
import { getProjectHostSetupForRepo } from '../../shared/project-host-setup-lookup'
import { projectHostSetupProjectionFromRepos } from '../../shared/project-host-setup-projection'
import type { Repo } from '../../shared/repo-types'

const TARGET_ID = 'target-1'
const REMOTE_PATH = '/srv/app'

const remoteRepo = {
  id: 'repo-remote',
  path: REMOTE_PATH,
  displayName: 'app',
  badgeColor: 'blue',
  addedAt: 1,
  kind: 'git',
  connectionId: TARGET_ID
} as unknown as Repo

function makeController(): {
  controller: RuntimeProjectHostSetupController
  addRepo: ReturnType<typeof vi.fn>
  addRemoteRepo: ReturnType<typeof vi.fn>
  cloneRepo: ReturnType<typeof vi.fn>
  projectId: string
} {
  const store = {
    getProjects: () => projectHostSetupProjectionFromRepos([remoteRepo]).projects,
    getProjectHostSetups: () => [],
    updateRepo: (_id: string, updates: Record<string, unknown>) => ({ ...remoteRepo, ...updates })
  }
  const addRepo = vi.fn().mockResolvedValue(remoteRepo)
  const addRemoteRepo = vi.fn().mockResolvedValue(remoteRepo)
  const cloneRepo = vi.fn().mockResolvedValue(remoteRepo)
  const controller = new RuntimeProjectHostSetupController({
    getStore: () => store as never,
    listRepos: () => [remoteRepo],
    addRepo,
    addRemoteRepo,
    cloneRepo,
    invalidateResolvedWorktrees: vi.fn(),
    invalidateWorktreeScan: vi.fn(),
    notifyReposChanged: vi.fn()
  })
  return {
    controller,
    addRepo,
    addRemoteRepo,
    cloneRepo,
    projectId: getProjectHostSetupForRepo([], remoteRepo).projectId
  }
}

describe('RuntimeProjectHostSetupController host routing', () => {
  it('registers an existing folder on an SSH host instead of refusing it (#11163)', async () => {
    const { controller, addRepo, addRemoteRepo, projectId } = makeController()

    const result = await controller.setupExistingFolder({
      projectId,
      hostId: `ssh:${TARGET_ID}`,
      path: REMOTE_PATH,
      kind: 'git'
    })

    expect(addRemoteRepo).toHaveBeenCalledWith({
      connectionId: TARGET_ID,
      remotePath: REMOTE_PATH,
      kind: 'git'
    })
    // The local registration path validates the path against the client filesystem.
    expect(addRepo).not.toHaveBeenCalled()
    expect(result.repo.id).toBe(remoteRepo.id)
  })

  it('decodes a percent-encoded SSH target back to its connection id', async () => {
    const { controller, addRemoteRepo, projectId } = makeController()

    await controller.setupExistingFolder({
      projectId,
      hostId: 'ssh:my%20host',
      path: REMOTE_PATH,
      kind: 'folder'
    })

    expect(addRemoteRepo).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'my host', kind: 'folder' })
    )
  })

  it('still uses the local registration for local and runtime hosts', async () => {
    const { controller, addRepo, addRemoteRepo, projectId } = makeController()

    await controller.setupExistingFolder({
      projectId,
      hostId: 'local',
      path: REMOTE_PATH,
      kind: 'git'
    })

    expect(addRepo).toHaveBeenCalledWith(REMOTE_PATH, 'git', 'local')
    expect(addRemoteRepo).not.toHaveBeenCalled()
  })

  it('refuses to clone onto an SSH host, because nothing here clones remotely', async () => {
    const { controller, cloneRepo, projectId } = makeController()

    await expect(
      controller.setupClone({
        projectId,
        hostId: `ssh:${TARGET_ID}`,
        url: 'https://example.com/app.git',
        destination: REMOTE_PATH
      })
    ).rejects.toThrow(/Cloning onto an SSH host is not supported/)
    expect(cloneRepo).not.toHaveBeenCalled()
  })
})
