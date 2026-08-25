import { describe, expect, it, vi } from 'vitest'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import { OrcaRuntimeService } from './orca-runtime'

function projectGroup(
  id: string,
  connectionId: string | null = null,
  parentGroupId: string | null = null
): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    connectionId,
    parentGroupId,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0
  }
}

function createRuntime() {
  const repos: Repo[] = [
    {
      id: 'dup',
      path: '/laptop/dup',
      displayName: 'Local',
      badgeColor: '#000000',
      addedAt: 1,
      executionHostId: 'local'
    },
    {
      id: 'dup',
      path: '/remote/dup',
      displayName: 'Remote',
      badgeColor: '#000000',
      addedAt: 2,
      connectionId: 'ssh-1'
    }
  ]
  const groups = [projectGroup('local-group'), projectGroup('remote-group', 'ssh-1')]
  const updateRepo = vi.fn(
    (id: string, updates: Partial<Repo>, hostId: ReturnType<typeof getRepoExecutionHostId>) => {
      const repo = repos.find(
        (candidate) => candidate.id === id && getRepoExecutionHostId(candidate) === hostId
      )
      if (!repo) {
        return null
      }
      Object.assign(repo, updates)
      return repo
    }
  )
  const createProjectGroup = vi.fn((input: Partial<ProjectGroup>) => {
    const group = projectGroup('created', input.connectionId ?? null, input.parentGroupId ?? null)
    groups.push(group)
    return group
  })
  const updateProjectGroup = vi.fn((id: string, updates: Partial<ProjectGroup>) => {
    const group = groups.find((candidate) => candidate.id === id)
    if (!group) {
      return null
    }
    Object.assign(group, updates)
    return group
  })
  const deleteProjectGroup = vi.fn(() => true)
  const removeProject = vi.fn()
  const removeProjectForHost = vi.fn()
  const runtime = new OrcaRuntimeService({
    getRepos: () => [...repos],
    getRepo: (id: string) => repos.find((repo) => repo.id === id) ?? null,
    getProjectGroups: () => [...groups],
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => null,
    setWorktreeMeta: vi.fn(),
    getGitHubCache: () => null,
    updateRepo,
    createProjectGroup,
    updateProjectGroup,
    deleteProjectGroup,
    removeProject,
    removeProjectForHost
  } as never)
  return {
    runtime,
    repos,
    updateRepo,
    createProjectGroup,
    updateProjectGroup,
    deleteProjectGroup,
    removeProjectForHost
  }
}

describe('runtime repo and project-group host scoping', () => {
  it('updates the resolved SSH row when repo ids collide across hosts', async () => {
    const { runtime, repos, updateRepo } = createRuntime()

    await runtime.updateRepo('path:/remote/dup', { displayName: 'Changed' })

    expect(repos.map((repo) => repo.displayName)).toEqual(['Local', 'Changed'])
    expect(updateRepo).toHaveBeenCalledWith('dup', { displayName: 'Changed' }, 'ssh:ssh-1')
  })

  it('rejects missing and cross-host project-group assignments', async () => {
    const { runtime, updateRepo } = createRuntime()

    await expect(
      runtime.updateRepo('path:/remote/dup', { projectGroupId: 'missing' })
    ).rejects.toThrow('project_group_not_found')
    await expect(
      runtime.updateRepo('path:/remote/dup', { projectGroupId: 'local-group' })
    ).rejects.toThrow('project_group_host_mismatch')
    expect(updateRepo).not.toHaveBeenCalled()
  })

  it('allows a repo and project group owned by the same SSH host', async () => {
    const { runtime, repos } = createRuntime()

    await runtime.updateRepo('path:/remote/dup', { projectGroupId: 'remote-group' })

    expect(repos[1].projectGroupId).toBe('remote-group')
  })

  it('inherits the parent host and rejects an explicit mismatched host', async () => {
    const { runtime, createProjectGroup } = createRuntime()

    await runtime.createProjectGroup({ name: 'Child', parentGroupId: 'remote-group' })
    expect(createProjectGroup).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'ssh-1', parentGroupId: 'remote-group' })
    )
    await expect(
      runtime.createProjectGroup({
        name: 'Wrong host',
        parentGroupId: 'remote-group',
        connectionId: 'ssh-2'
      })
    ).rejects.toThrow('project_group_host_mismatch')
  })

  it('fences repo updates and removals to the requested SSH connection', async () => {
    const { runtime, repos, updateRepo, removeProjectForHost } = createRuntime()

    await expect(
      runtime.updateRepo('path:/laptop/dup', { displayName: 'Wrong' }, 'ssh-1')
    ).rejects.toThrow('repo_not_found')
    expect(updateRepo).not.toHaveBeenCalled()
    await runtime.updateRepo('path:/remote/dup', { displayName: 'Remote changed' }, 'ssh-1')
    expect(repos.map((repo) => repo.displayName)).toEqual(['Local', 'Remote changed'])

    await expect(runtime.removeProject('path:/laptop/dup', 'ssh-1')).rejects.toThrow(
      'repo_not_found'
    )
    await runtime.removeProject('path:/remote/dup', 'ssh-1')
    expect(removeProjectForHost).toHaveBeenCalledWith('dup', 'ssh:ssh-1')
  })

  it('fences project-group updates and deletes to the requested SSH connection', async () => {
    const { runtime, updateProjectGroup, deleteProjectGroup } = createRuntime()

    await expect(
      runtime.updateProjectGroup('local-group', { name: 'Wrong' }, 'ssh-1')
    ).resolves.toBeNull()
    await expect(runtime.deleteProjectGroup('local-group', 'ssh-1')).resolves.toEqual({
      deleted: false
    })
    expect(updateProjectGroup).not.toHaveBeenCalled()
    expect(deleteProjectGroup).not.toHaveBeenCalled()

    await expect(
      runtime.updateProjectGroup('remote-group', { name: 'Remote changed' }, 'ssh-1')
    ).resolves.toMatchObject({ name: 'Remote changed' })
    await expect(runtime.deleteProjectGroup('remote-group', 'ssh-1')).resolves.toEqual({
      deleted: true
    })
  })
})
