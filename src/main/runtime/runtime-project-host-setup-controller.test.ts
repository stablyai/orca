// The CLI/runtime RPC used to refuse `--host ssh:*` with "set the project up from the Orca desktop
// app" — while the desktop IPC handler in the *same process* routed it correctly through
// addRemoteRepoFromPath. Safe but wrong: the process refusing is the one that owns the connection.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeProjectHostSetupController } from './runtime-project-host-setup-controller'
import { getProjectHostSetupForRepo } from '../../shared/project-host-setup-lookup'
import { projectHostSetupProjectionFromRepos } from '../../shared/project-host-setup-projection'
import type { Repo } from '../../shared/repo-types'
import type * as FilesystemAuth from '../ipc/filesystem-auth'

const mocks = vi.hoisted(() => ({ invalidateAuthorizedRootsCache: vi.fn() }))

vi.mock('../ipc/filesystem-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof FilesystemAuth>()),
  invalidateAuthorizedRootsCache: mocks.invalidateAuthorizedRootsCache
}))

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

function makeController(storeMutations: Record<string, unknown> = {}): {
  controller: RuntimeProjectHostSetupController
  addRepo: ReturnType<typeof vi.fn>
  addRemoteRepo: ReturnType<typeof vi.fn>
  cloneRepo: ReturnType<typeof vi.fn>
  invalidateResolvedWorktrees: ReturnType<typeof vi.fn>
  invalidateWorktreeScan: ReturnType<typeof vi.fn>
  notifyReposChanged: ReturnType<typeof vi.fn>
  projectId: string
} {
  const store = {
    getProjects: () => projectHostSetupProjectionFromRepos([remoteRepo]).projects,
    getProjectHostSetups: () => [],
    updateRepo: (_id: string, updates: Record<string, unknown>) => ({ ...remoteRepo, ...updates }),
    ...storeMutations
  }
  const addRepo = vi.fn().mockResolvedValue(remoteRepo)
  const addRemoteRepo = vi.fn().mockResolvedValue(remoteRepo)
  const cloneRepo = vi.fn().mockResolvedValue(remoteRepo)
  const invalidateResolvedWorktrees = vi.fn()
  const invalidateWorktreeScan = vi.fn()
  const notifyReposChanged = vi.fn()
  const controller = new RuntimeProjectHostSetupController({
    getStore: () => store as never,
    listRepos: () => [remoteRepo],
    addRepo,
    addRemoteRepo,
    cloneRepo,
    invalidateResolvedWorktrees,
    invalidateWorktreeScan,
    notifyReposChanged
  })
  return {
    controller,
    addRepo,
    addRemoteRepo,
    cloneRepo,
    invalidateResolvedWorktrees,
    invalidateWorktreeScan,
    notifyReposChanged,
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

// The desktop IPC handlers announce every setup change, and `repo.rm` forgets the repo it removes.
// The runtime RPC behind `orca project setup-*` did neither, so an open window kept the old list.
describe('RuntimeProjectHostSetupController change announcements', () => {
  const setup = getProjectHostSetupForRepo([], remoteRepo)
  const project = projectHostSetupProjectionFromRepos([remoteRepo]).projects[0]

  beforeEach(() => {
    mocks.invalidateAuthorizedRootsCache.mockClear()
  })

  it('forgets a removed repo and tells open clients', () => {
    const { controller, invalidateResolvedWorktrees, invalidateWorktreeScan, notifyReposChanged } =
      makeController({ deleteProjectHostSetup: () => ({ project, setup, repo: remoteRepo }) })

    controller.deleteSetup({ setupId: setup.id })

    expect(invalidateResolvedWorktrees).toHaveBeenCalledTimes(1)
    expect(invalidateWorktreeScan).toHaveBeenCalledWith(remoteRepo.id)
    expect(mocks.invalidateAuthorizedRootsCache).toHaveBeenCalledTimes(1)
    expect(notifyReposChanged).toHaveBeenCalledTimes(1)
  })

  it('tells open clients when the removed setup had no repo behind it', () => {
    const { controller, invalidateResolvedWorktrees, invalidateWorktreeScan, notifyReposChanged } =
      makeController({ deleteProjectHostSetup: () => ({ project, setup }) })

    controller.deleteSetup({ setupId: setup.id })

    expect(notifyReposChanged).toHaveBeenCalledTimes(1)
    expect(invalidateResolvedWorktrees).not.toHaveBeenCalled()
    expect(invalidateWorktreeScan).not.toHaveBeenCalled()
    expect(mocks.invalidateAuthorizedRootsCache).not.toHaveBeenCalled()
  })

  it('forgets a repo it registered when the setup cannot be linked to the project', async () => {
    const registeredRepo = { ...remoteRepo, id: 'repo-new' }
    const removeProject = vi.fn()
    const {
      controller,
      addRepo,
      invalidateResolvedWorktrees,
      invalidateWorktreeScan,
      notifyReposChanged
    } = makeController({ removeProject })
    addRepo.mockResolvedValue(registeredRepo)

    await expect(
      controller.setupExistingFolder({
        projectId: 'github:someone/else',
        hostId: 'local',
        path: REMOTE_PATH,
        kind: 'git'
      })
    ).rejects.toThrow('Imported folder does not match the selected project identity.')

    expect(removeProject).toHaveBeenCalledWith(registeredRepo.id)
    expect(invalidateResolvedWorktrees).toHaveBeenCalledTimes(1)
    expect(invalidateWorktreeScan).toHaveBeenCalledWith(registeredRepo.id)
    expect(mocks.invalidateAuthorizedRootsCache).toHaveBeenCalledTimes(1)
    expect(notifyReposChanged).toHaveBeenCalledTimes(1)
  })

  it('announces nothing when there was no such setup to remove', () => {
    const { controller, notifyReposChanged } = makeController({
      deleteProjectHostSetup: () => null
    })

    expect(() => controller.deleteSetup({ setupId: 'missing' })).toThrow(
      'Project host setup not found: missing'
    )
    expect(notifyReposChanged).not.toHaveBeenCalled()
  })

  it('tells open clients about a created setup', () => {
    const { controller, notifyReposChanged, projectId } = makeController({
      createProjectHostSetup: () => ({ project, setup })
    })

    controller.createSetup({ projectId, hostId: 'local' })

    expect(notifyReposChanged).toHaveBeenCalledTimes(1)
  })

  it('tells open clients about an updated setup', () => {
    const { controller, notifyReposChanged } = makeController({
      updateProjectHostSetup: () => ({ project, setup })
    })

    controller.updateSetup({ setupId: setup.id, updates: { displayName: 'renamed' } })

    expect(notifyReposChanged).toHaveBeenCalledTimes(1)
  })
})
