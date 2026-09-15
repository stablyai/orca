import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import { RuntimeNestedRepoImport } from './runtime-nested-repo-import'
import { scanNestedRepos } from '../project-groups/nested-repo-discovery'

vi.mock('../git/runner', () => ({
  awaitWindowsHostGitEnvironmentReady: vi.fn()
}))

vi.mock('../git/repo', () => ({
  getRepoName: (path: string) => path.split('/').at(-1) ?? path,
  isGitRepo: vi.fn(() => true)
}))

vi.mock('../project-groups/nested-repo-discovery', () => ({
  scanNestedRepos: vi.fn()
}))

vi.mock('../project-groups/nested-repo-import-target', () => ({
  createNestedRepoImportTargetResolver: () => ({
    resolveLocal: (path: string) => Promise.resolve(path)
  })
}))

function makeRepo(id: string, path: string): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: '#999999',
    addedAt: 1,
    kind: 'git'
  }
}

describe('RuntimeNestedRepoImport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('groups an existing git root and child without replacing either repo', async () => {
    const root = makeRepo('root-id', '/workspace')
    const child = makeRepo('child-id', '/workspace/api')
    const group: ProjectGroup = {
      id: 'group-id',
      name: 'workspace',
      parentPath: '/workspace',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    vi.mocked(scanNestedRepos).mockResolvedValue({
      selectedPath: root.path,
      selectedPathKind: 'git_repo',
      repos: [{ path: child.path, displayName: child.displayName, depth: 1 }],
      truncated: false,
      timedOut: false,
      stopped: false,
      durationMs: 1,
      maxDepth: 3,
      maxRepos: 100,
      timeoutMs: 15_000
    })
    const moveProjectToGroup = vi.fn()
    const addRepo = vi.fn()
    const store = {
      getRepos: () => [root, child],
      createProjectGroup: vi.fn(() => group),
      moveProjectToGroup,
      addRepo,
      deleteProjectGroup: vi.fn()
    }
    const importer = new RuntimeNestedRepoImport({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The test double supplies every store method exercised by this import path.
      getStore: () => store as never,
      invalidateResolvedWorktrees: vi.fn(),
      invalidateWorktreeScan: vi.fn(),
      notifyReposChanged: vi.fn()
    })

    const result = await importer.import({
      parentPath: root.path,
      groupName: group.name,
      projectPaths: [child.path],
      mode: 'group'
    })

    expect(result.projects).toEqual([
      { path: root.path, projectId: root.id, status: 'already-known' },
      { path: child.path, projectId: child.id, status: 'already-known' }
    ])
    expect(moveProjectToGroup).toHaveBeenNthCalledWith(1, root.id, group.id, 0)
    expect(moveProjectToGroup).toHaveBeenNthCalledWith(2, child.id, group.id, 1)
    expect(addRepo).not.toHaveBeenCalled()
  })
})
