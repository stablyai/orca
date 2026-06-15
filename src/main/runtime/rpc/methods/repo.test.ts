import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { REPO_METHODS } from './repo'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('repo RPC methods', () => {
  it('creates a repo on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      createRepo: vi.fn().mockResolvedValue({
        repo: { id: 'repo-1', path: '/srv/projects/new-app', kind: 'git' }
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: REPO_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('repo.create', {
        parentPath: '/srv/projects',
        name: 'new-app',
        kind: 'git'
      })
    )

    expect(runtime.createRepo).toHaveBeenCalledWith('/srv/projects', 'new-app', 'git')
    expect(response).toMatchObject({
      ok: true,
      result: { repo: { id: 'repo-1', path: '/srv/projects/new-app' } }
    })
  })

  it('reports runtime Git availability without exposing command details', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      isGitAvailable: vi.fn().mockResolvedValue(true)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: REPO_METHODS })

    const response = await dispatcher.dispatch(makeRequest('repo.gitAvailable'))

    expect(runtime.isGitAvailable).toHaveBeenCalled()
    expect(response).toMatchObject({
      ok: true,
      result: { available: true }
    })
  })

  it('clones a repo on the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      cloneRepo: vi.fn().mockResolvedValue({
        id: 'repo-1',
        path: '/srv/projects/orca',
        kind: 'git'
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: REPO_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('repo.clone', {
        url: 'https://github.com/example/orca.git',
        destination: '/srv/projects'
      })
    )

    expect(runtime.cloneRepo).toHaveBeenCalledWith(
      'https://github.com/example/orca.git',
      '/srv/projects'
    )
    expect(response).toMatchObject({
      ok: true,
      result: { repo: { id: 'repo-1', path: '/srv/projects/orca' } }
    })
  })

  it('shows a repo with the CLI-compatible response shape', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      showRepo: vi.fn().mockResolvedValue({
        id: 'repo-1',
        path: '/srv/projects/orca',
        kind: 'git'
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: REPO_METHODS })

    const response = await dispatcher.dispatch(makeRequest('repo.show', { repo: 'repo-1' }))

    expect(runtime.showRepo).toHaveBeenCalledWith('repo-1')
    expect(response).toMatchObject({
      ok: true,
      result: { repo: { id: 'repo-1', path: '/srv/projects/orca' } }
    })
  })

  it('lists sparse checkout presets for a repo', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listSparsePresets: vi.fn().mockResolvedValue([
        {
          id: 'preset-1',
          projectId: 'repo-1',
          name: 'Frontend',
          directories: ['src/renderer'],
          createdAt: 1,
          updatedAt: 2
        }
      ])
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: REPO_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('repo.sparsePresets', { repo: 'repo-1' })
    )

    expect(runtime.listSparsePresets).toHaveBeenCalledWith('repo-1')
    expect(response).toMatchObject({
      ok: true,
      result: { presets: [{ id: 'preset-1', directories: ['src/renderer'] }] }
    })
  })

  it('saves sparse checkout presets for a repo', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      saveSparsePreset: vi.fn().mockResolvedValue({
        id: 'preset-1',
        projectId: 'repo-1',
        name: 'Frontend',
        directories: ['src/renderer'],
        createdAt: 1,
        updatedAt: 2
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: REPO_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('repo.saveSparsePreset', {
        repo: 'repo-1',
        name: 'Frontend',
        directories: ['src/renderer']
      })
    )

    expect(runtime.saveSparsePreset).toHaveBeenCalledWith('repo-1', {
      name: 'Frontend',
      directories: ['src/renderer']
    })
    expect(response).toMatchObject({
      ok: true,
      result: { preset: { id: 'preset-1', directories: ['src/renderer'] } }
    })
  })

  it('routes repository hook operations to the runtime server', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getRepoHooks: vi.fn().mockResolvedValue({
        hasHooksFile: true,
        hooks: { scripts: { setup: 'pnpm install' } },
        setupRunPolicy: 'run-by-default',
        source: 'orca.yaml',
        setupTrust: {
          contentHash: 'hash-1',
          scriptContent: 'pnpm install'
        }
      }),
      checkRepoHooks: vi.fn().mockResolvedValue({
        hasHooks: true,
        hooks: { scripts: { setup: 'pnpm install' } },
        mayNeedUpdate: false
      }),
      inspectRepoSetupScriptImports: vi.fn().mockResolvedValue([
        {
          provider: 'conductor',
          label: 'Conductor',
          files: ['conductor.json'],
          setup: 'pnpm install'
        }
      ]),
      readRepoIssueCommand: vi.fn().mockResolvedValue({
        localContent: null,
        sharedContent: 'Fix {{artifact_url}}',
        effectiveContent: 'Fix {{artifact_url}}',
        localFilePath: '/srv/repo/.orca/issue-command',
        source: 'shared'
      }),
      writeRepoIssueCommand: vi.fn().mockResolvedValue({ ok: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: REPO_METHODS })

    const hooksResponse = await dispatcher.dispatch(makeRequest('repo.hooks', { repo: 'repo-1' }))
    await dispatcher.dispatch(makeRequest('repo.hooksCheck', { repo: 'repo-1' }))
    await dispatcher.dispatch(makeRequest('repo.setupScriptImports', { repo: 'repo-1' }))
    await dispatcher.dispatch(makeRequest('repo.issueCommandRead', { repo: 'repo-1' }))
    await dispatcher.dispatch(
      makeRequest('repo.issueCommandWrite', {
        repo: 'repo-1',
        content: 'Fix it'
      })
    )

    expect(runtime.getRepoHooks).toHaveBeenCalledWith('repo-1')
    expect(hooksResponse).toMatchObject({
      ok: true,
      result: { setupTrust: { contentHash: 'hash-1', scriptContent: 'pnpm install' } }
    })
    expect(runtime.checkRepoHooks).toHaveBeenCalledWith('repo-1')
    expect(runtime.inspectRepoSetupScriptImports).toHaveBeenCalledWith('repo-1')
    expect(runtime.readRepoIssueCommand).toHaveBeenCalledWith('repo-1')
    expect(runtime.writeRepoIssueCommand).toHaveBeenCalledWith('repo-1', 'Fix it')
  })

  it('persists GitHub issue source preference updates', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateRepo: vi.fn().mockResolvedValue({
        id: 'repo-1',
        path: '/srv/repo',
        issueSourcePreference: 'origin'
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: REPO_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('repo.update', {
        repo: 'repo-1',
        updates: { issueSourcePreference: 'origin' }
      })
    )

    expect(runtime.updateRepo).toHaveBeenCalledWith('repo-1', {
      issueSourcePreference: 'origin'
    })
    expect(response).toMatchObject({
      ok: true,
      result: { repo: { id: 'repo-1', issueSourcePreference: 'origin' } }
    })
  })

  it('persists fork sync mode updates', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateRepo: vi.fn().mockResolvedValue({
        id: 'repo-1',
        path: '/srv/repo',
        forkSyncMode: 'safe-auto'
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: REPO_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('repo.update', {
        repo: 'repo-1',
        updates: { forkSyncMode: 'safe-auto' }
      })
    )

    expect(runtime.updateRepo).toHaveBeenCalledWith('repo-1', {
      forkSyncMode: 'safe-auto'
    })
    expect(response).toMatchObject({
      ok: true,
      result: { repo: { id: 'repo-1', forkSyncMode: 'safe-auto' } }
    })
  })

  it('persists resolved GitHub upstream metadata updates', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      updateRepo: vi.fn().mockResolvedValue({
        id: 'repo-1',
        path: '/srv/repo',
        upstream: { owner: 'stablyai', repo: 'orca' }
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: REPO_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('repo.update', {
        repo: 'repo-1',
        updates: { upstream: { owner: 'stablyai', repo: 'orca' } }
      })
    )

    expect(runtime.updateRepo).toHaveBeenCalledWith('repo-1', {
      upstream: { owner: 'stablyai', repo: 'orca' }
    })
    expect(response).toMatchObject({
      ok: true,
      result: { repo: { id: 'repo-1', upstream: { owner: 'stablyai', repo: 'orca' } } }
    })
  })

  it('routes project group mutations to the runtime server', async () => {
    const group = {
      id: 'group-1',
      name: 'Platform',
      parentPath: '/srv/platform',
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listProjectGroups: vi.fn().mockReturnValue([group]),
      createProjectGroup: vi.fn().mockResolvedValue(group),
      updateProjectGroup: vi.fn().mockResolvedValue({ ...group, name: 'Core' }),
      deleteProjectGroup: vi.fn().mockResolvedValue({ deleted: true }),
      moveProjectToGroup: vi.fn().mockResolvedValue({ id: 'repo-1', projectGroupId: group.id }),
      listFolderWorkspaces: vi.fn().mockReturnValue([
        {
          id: 'folder-workspace-1',
          projectGroupId: group.id,
          name: 'Refund fix',
          folderPath: '/srv/platform',
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 1,
          lastActivityAt: 0,
          createdAt: 1,
          updatedAt: 1
        }
      ]),
      createFolderWorkspace: vi.fn().mockResolvedValue({ id: 'folder-workspace-2' }),
      updateFolderWorkspace: vi.fn().mockResolvedValue({ id: 'folder-workspace-1', comment: 'x' }),
      deleteFolderWorkspace: vi.fn().mockResolvedValue({ deleted: true }),
      getFolderWorkspacePathStatus: vi
        .fn()
        .mockResolvedValue({ path: '/srv/platform', exists: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: REPO_METHODS })

    await dispatcher.dispatch(makeRequest('projectGroup.list'))
    await dispatcher.dispatch(
      makeRequest('projectGroup.create', {
        name: 'Platform',
        parentPath: '/srv/platform',
        createdFrom: 'folder-scan'
      })
    )
    await dispatcher.dispatch(
      makeRequest('projectGroup.update', {
        groupId: group.id,
        updates: { name: 'Core', isCollapsed: true }
      })
    )
    await dispatcher.dispatch(makeRequest('projectGroup.delete', { groupId: group.id }))
    const moveResponse = await dispatcher.dispatch(
      makeRequest('projectGroup.moveProject', {
        repo: 'repo-1',
        groupId: group.id,
        order: 2
      })
    )
    const folderListResponse = await dispatcher.dispatch(makeRequest('folderWorkspace.list'))
    await dispatcher.dispatch(
      makeRequest('folderWorkspace.create', {
        projectGroupId: group.id,
        name: 'Refund fix'
      })
    )
    await dispatcher.dispatch(
      makeRequest('folderWorkspace.update', {
        folderWorkspaceId: 'folder-workspace-1',
        updates: { comment: 'x' }
      })
    )
    await dispatcher.dispatch(
      makeRequest('folderWorkspace.delete', { folderWorkspaceId: 'folder-workspace-1' })
    )
    const statusResponse = await dispatcher.dispatch(
      makeRequest('folderWorkspace.getPathStatus', {
        scope: 'folder-workspace',
        folderWorkspaceId: 'folder-workspace-1'
      })
    )

    expect(runtime.listProjectGroups).toHaveBeenCalled()
    expect(runtime.createProjectGroup).toHaveBeenCalledWith({
      name: 'Platform',
      parentPath: '/srv/platform',
      createdFrom: 'folder-scan'
    })
    expect(runtime.updateProjectGroup).toHaveBeenCalledWith(group.id, {
      name: 'Core',
      isCollapsed: true
    })
    expect(runtime.deleteProjectGroup).toHaveBeenCalledWith(group.id)
    expect(runtime.moveProjectToGroup).toHaveBeenCalledWith('repo-1', group.id, 2)
    expect(runtime.listFolderWorkspaces).toHaveBeenCalled()
    expect(runtime.createFolderWorkspace).toHaveBeenCalledWith({
      projectGroupId: group.id,
      name: 'Refund fix'
    })
    expect(runtime.updateFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1', {
      comment: 'x'
    })
    expect(runtime.deleteFolderWorkspace).toHaveBeenCalledWith('folder-workspace-1')
    expect(runtime.getFolderWorkspacePathStatus).toHaveBeenCalledWith({
      scope: 'folder-workspace',
      folderWorkspaceId: 'folder-workspace-1'
    })
    expect(moveResponse).toMatchObject({
      ok: true,
      result: { repo: { id: 'repo-1', projectGroupId: group.id } }
    })
    expect(folderListResponse).toMatchObject({
      ok: true,
      result: {
        folderWorkspaces: [expect.objectContaining({ id: 'folder-workspace-1' })]
      }
    })
    expect(statusResponse).toMatchObject({
      ok: true,
      result: { status: { path: '/srv/platform', exists: true } }
    })
  })

  it('allows separate nested-repo imports without a group name', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      importNestedRepos: vi.fn().mockResolvedValue({
        repos: [{ path: '/srv/platform/api', projectId: 'repo-1', status: 'imported' }],
        importedCount: 1,
        alreadyKnownCount: 0,
        failedCount: 0
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: REPO_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('projectGroup.importNested', {
        parentPath: '/srv/platform',
        projectPaths: ['/srv/platform/api'],
        mode: 'separate'
      })
    )

    expect(runtime.importNestedRepos).toHaveBeenCalledWith({
      parentPath: '/srv/platform',
      groupName: '',
      projectPaths: ['/srv/platform/api'],
      mode: 'separate'
    })
    expect(response).toMatchObject({
      ok: true,
      result: { importedCount: 1, failedCount: 0 }
    })
  })

  it('allows grouped nested-repo imports with a blank group name', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      importNestedRepos: vi.fn().mockResolvedValue({
        projects: [{ path: '/srv/platform/api', projectId: 'repo-1', status: 'imported' }],
        importedCount: 1,
        alreadyKnownCount: 0,
        failedCount: 0
      })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: REPO_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('projectGroup.importNested', {
        parentPath: '/srv/platform',
        groupName: '',
        projectPaths: ['/srv/platform/api'],
        mode: 'group'
      })
    )

    expect(runtime.importNestedRepos).toHaveBeenCalledWith({
      parentPath: '/srv/platform',
      groupName: '',
      projectPaths: ['/srv/platform/api'],
      mode: 'group'
    })
    expect(response).toMatchObject({
      ok: true,
      result: { importedCount: 1, failedCount: 0 }
    })
  })
})
