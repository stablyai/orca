import { describe, expect, it } from 'vitest'
import type { FolderWorkspace, Repo } from '../../shared/types'
import { OrcaRuntimeService } from './orca-runtime'

function folderWorkspace(
  executionHostId: FolderWorkspace['executionHostId'] = undefined
): FolderWorkspace {
  return {
    id: 'folder_workspace',
    projectGroupId: 'project_group',
    name: 'folder',
    folderPath: '/workspace',
    executionHostId,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

function folderRuntime(workspace: FolderWorkspace, repos: Repo[] = []): OrcaRuntimeService {
  return new OrcaRuntimeService({
    getFolderWorkspaces: () => [workspace],
    getProjectGroups: () => [],
    getRepos: () => repos
  } as never)
}

describe('OrcaRuntimeService orchestration report host scope', () => {
  it('resolves a worktree in an SSH-backed repo as remote', () => {
    const runtime = new OrcaRuntimeService({
      getWorktreeMeta: () => undefined,
      getRepo: (id: string) =>
        id === 'repo_ssh'
          ? {
              id,
              path: '/remote/repo',
              displayName: 'remote repo',
              badgeColor: 'blue',
              addedAt: 1,
              connectionId: 'ssh-connection'
            }
          : undefined
    } as never)

    expect(runtime.resolveOrchestrationReportWorktreeHostScope('repo_ssh::/remote/worktree')).toBe(
      'remote'
    )
  })

  it('returns unknown when repo metadata is unavailable', () => {
    const runtime = new OrcaRuntimeService({
      getRepo: () => undefined,
      getWorktreeMeta: () => undefined
    } as never)

    expect(runtime.resolveOrchestrationReportWorktreeHostScope('missing::/worktree')).toBe(
      'unknown'
    )
  })

  it('resolves a local folder execution host as local', () => {
    const runtime = folderRuntime(folderWorkspace('local'))

    expect(runtime.resolveOrchestrationReportWorktreeHostScope('folder:folder_workspace')).toBe(
      'local'
    )
  })

  it('resolves an SSH folder execution host as remote', () => {
    const runtime = folderRuntime(folderWorkspace('ssh:ssh-target'))

    expect(runtime.resolveOrchestrationReportWorktreeHostScope('folder:folder_workspace')).toBe(
      'remote'
    )
  })

  it('resolves a runtime folder execution host as remote', () => {
    const runtime = folderRuntime(folderWorkspace('runtime:environment'))

    expect(runtime.resolveOrchestrationReportWorktreeHostScope('folder:folder_workspace')).toBe(
      'remote'
    )
  })

  it('returns unknown when folder connection inference is ambiguous', () => {
    const repos = [
      { id: 'repo_local', path: '/workspace/local', connectionId: null },
      { id: 'repo_ssh', path: '/workspace/remote', connectionId: 'ssh-target' }
    ] as Repo[]
    const runtime = folderRuntime(folderWorkspace(), repos)

    expect(runtime.resolveOrchestrationReportWorktreeHostScope('folder:folder_workspace')).toBe(
      'unknown'
    )
  })
})
