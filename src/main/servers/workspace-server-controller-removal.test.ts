import { afterEach, expect, it, vi } from 'vitest'
import '../runtime/orca-runtime-test-mocks.spec'
import { store, TEST_REPO_ID } from '../runtime/orca-runtime-test-fixtures.spec'
import { WorkspaceServerProcessManager } from './workspace-server-process-manager'
import { RuntimeRepositorySettingsController } from '../runtime/runtime-repository-settings-controller'
import { RuntimeProjectGroupController } from '../runtime/runtime-project-group-controller'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import { folderWorkspaceKey } from '../../shared/workspace-scope'

const managers: WorkspaceServerProcessManager[] = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()))
})
function managerFixture() {
  const manager = new WorkspaceServerProcessManager(() => {
    throw new Error('fixture start failure')
  })
  managers.push(manager)
  const start = (id: string, permit?: ReturnType<typeof manager.beginStart>) =>
    manager.start(
      { worktreeId: id, port: 4008, name: 'test' },
      { program: 'unused', cwd: '/tmp' },
      permit
    )
  return { manager, start }
}
function projectFixture(host: 'local' | 'ssh:remote' | 'runtime:remote' = 'local') {
  const { manager, start } = managerFixture()
  const local = { ...store.getRepo(TEST_REPO_ID)!, executionHostId: 'local' as const }
  const repo = { ...local, executionHostId: host }
  const remove = vi.fn()
  const controller = new RuntimeRepositorySettingsController({
    workspaceServers: manager,
    getStore: () => ({
      ...store,
      getRepos: () => (host === 'local' ? [local] : [local, repo]),
      removeProjectForHost: remove
    }),
    resolveRepo: async () => repo,
    forgetTerminalTopology: vi.fn(),
    stopProjectTerminals: vi.fn(async () => {}),
    invalidateResolvedWorktrees: vi.fn(),
    invalidateWorktreeScan: vi.fn(),
    notifyReposChanged: vi.fn()
  })
  return { manager, start, remove, controller, repo }
}
it('fences all project workspaces and awaits server stop before project metadata removal', async () => {
  const { manager, start, remove, controller, repo } = projectFixture()
  const pending = manager.beginStart()
  const stopped = Promise.withResolvers<void>()
  vi.spyOn(manager, 'stopProject').mockReturnValue(stopped.promise)
  const removal = controller.remove(repo)
  expect(remove).not.toHaveBeenCalled()
  expect(() => start(`${TEST_REPO_ID}::/tmp/hidden`)).toThrow('removal')
  stopped.resolve()
  await removal
  expect(remove).toHaveBeenCalledOnce()
  expect(() => start(`${TEST_REPO_ID}::/tmp/hidden`, pending)).toThrow('removed')
  pending.release()
})
it('preserves project metadata when managed termination cannot be verified', async () => {
  const { manager, remove, controller, repo } = projectFixture()
  vi.spyOn(manager, 'stopProject').mockRejectedValue(new Error('termination unverified'))
  await expect(controller.remove(repo)).rejects.toThrow('termination unverified')
  expect(remove).not.toHaveBeenCalled()
})
it.each(['ssh:remote', 'runtime:remote'] as const)(
  'preserves same-ID local servers when removing a %s project twin',
  async (host) => {
    const { manager, start, controller, repo } = projectFixture(host)
    const stop = vi.spyOn(manager, 'stopProject')
    const pending = manager.beginStart()
    await controller.remove(repo)
    expect(stop).not.toHaveBeenCalled()
    expect(() => start(`${TEST_REPO_ID}::/tmp/hidden`, pending)).not.toThrow()
    pending.release()
  }
)
function folderFixture(connectionId: string | null = null) {
  const { manager, start } = managerFixture()
  const workspace: FolderWorkspace = {
    id: 'folder-a',
    projectGroupId: 'g',
    name: 'a',
    folderPath: '/tmp/a',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    updatedAt: 0,
    createdAt: 0
  }
  const remove = vi.fn(() => true)
  const cleanup = vi.fn()
  const teardown = vi.fn(async () => {})
  const controller = new RuntimeProjectGroupController({
    workspaceServers: manager,
    getStore: () => ({
      ...store,
      getFolderWorkspaces: () => [workspace],
      removeFolderWorkspace: remove
    }),
    resolveRepo: async () => store.getRepo(TEST_REPO_ID)!,
    notifyReposChanged: vi.fn(),
    resolveFolderConnectionId: () => connectionId,
    teardownFolderWorkspacePtys: teardown,
    cleanupRemovedFolderWorkspaceState: cleanup,
    emitWorktreeLifecycle: vi.fn()
  })
  return { manager, start, workspace, remove, cleanup, teardown, controller }
}
it('fences floating-folder deletion and requires server stop even without a PTY provider', async () => {
  const { manager, start, workspace, remove, controller } = folderFixture()
  const pending = manager.beginStart()
  const stopped = Promise.withResolvers<void>()
  vi.spyOn(manager, 'stopWorktree').mockReturnValue(stopped.promise)
  const removal = controller.deleteFolderWorkspace(workspace.id)
  expect(remove).not.toHaveBeenCalled()
  expect(() => start(folderWorkspaceKey(workspace.id))).toThrow('removal')
  stopped.resolve()
  await removal
  expect(remove).toHaveBeenCalledOnce()
  expect(() => start(folderWorkspaceKey(workspace.id), pending)).toThrow('removed')
  pending.release()
})
it('does not forget a floating folder when its server stop fails', async () => {
  const { manager, workspace, remove, cleanup, controller } = folderFixture()
  vi.spyOn(manager, 'stopWorktree').mockRejectedValue(new Error('termination unverified'))
  await expect(controller.deleteFolderWorkspace(workspace.id)).rejects.toThrow(
    'termination unverified'
  )
  expect(remove).not.toHaveBeenCalled()
  expect(cleanup).not.toHaveBeenCalled()
})
it('resolves a floating folder group SSH host before fencing or stopping a local same-ID run', async () => {
  const { manager, start, workspace, controller } = folderFixture('group-ssh')
  const stop = vi.spyOn(manager, 'stopWorktree')
  const permit = manager.beginStart()
  await controller.deleteFolderWorkspace(workspace.id)
  expect(stop).not.toHaveBeenCalled()
  expect(() => start(folderWorkspaceKey(workspace.id), permit)).not.toThrow()
  permit.release()
})

it('stops servers of a runtime-stamped floating folder whose resolved execution is local', async () => {
  const { manager, workspace, controller } = folderFixture()
  workspace.executionHostId = 'runtime:registered-here'
  const stop = vi.spyOn(manager, 'stopWorktree')
  await controller.deleteFolderWorkspace(workspace.id)
  expect(stop).toHaveBeenCalledExactlyOnceWith(folderWorkspaceKey(workspace.id))
})
