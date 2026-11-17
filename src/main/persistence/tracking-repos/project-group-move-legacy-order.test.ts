import { describe, expect, it, vi } from 'vitest'
import {
  getDefaultPersistedState,
  getDefaultRepoHookSettings
} from '../../../shared/orca-profiles/constants'
import type { ProjectGroup } from '../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../shared/repository/repo-types'
import { moveProjectToGroupInState } from './project-group-operations'

function makeRepo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '#3b82f6',
    addedAt: 1,
    hookSettings: getDefaultRepoHookSettings(),
    ...overrides
  }
}

function makeGroup(id: string, overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('moveProjectToGroupInState legacy unranked siblings with subgroups', () => {
  it('initializes unranked siblings and child subgroups in walker order before appending moved repo', () => {
    const parent = makeGroup('g-parent', { tabOrder: 0 })
    const subPinned = makeGroup('sub-pinned', {
      parentGroupId: 'g-parent',
      tabOrder: 0,
      isPinned: true
    })
    const subUnpinned = makeGroup('sub-unpinned', { parentGroupId: 'g-parent', tabOrder: 0 })
    const repoPinned = makeRepo('r-pinned', { projectGroupId: 'g-parent', isPinned: true })
    const repoUnpinnedA = makeRepo('r-a', { projectGroupId: 'g-parent' })
    const repoUnpinnedB = makeRepo('r-b', { projectGroupId: 'g-parent' })
    const foreignTwin = makeRepo('r-b', {
      path: '/remote/r-b',
      projectGroupId: 'g-parent',
      executionHostId: 'ssh:remote'
    })
    const incoming = makeRepo('r-incoming')

    const state = {
      ...getDefaultPersistedState('/home/test'),
      repos: [repoUnpinnedA, repoPinned, repoUnpinnedB, foreignTwin, incoming],
      projectGroups: [parent, subPinned, subUnpinned]
    }
    const scheduleSave = vi.fn()

    const moved = moveProjectToGroupInState(
      {
        state,
        scheduleSave,
        hydrateRepo: (repo) => repo
      },
      { id: 'r-incoming' },
      'g-parent'
    )

    expect(moved).toMatchObject({
      id: 'r-incoming',
      projectGroupId: 'g-parent',
      projectGroupOrder: 5
    })
    // Walker order when !hasExplicitRepoOrder: pinned repos -> pinned groups -> unpinned repos -> unpinned groups
    expect(repoPinned.projectGroupOrder).toBe(0)
    expect(subPinned.tabOrder).toBe(1)
    expect(repoUnpinnedA.projectGroupOrder).toBe(2)
    expect(repoUnpinnedB.projectGroupOrder).toBe(3)
    expect(subUnpinned.tabOrder).toBe(4)
    expect(foreignTwin.projectGroupOrder).toBeUndefined()
    expect(scheduleSave).toHaveBeenCalledWith(['repos', 'projectGroups'])
  })

  it('rejects assigning a project to a group owned by another execution host', () => {
    const localRepo = makeRepo('shared-repo', { executionHostId: 'local' })
    const remoteGroup = makeGroup('remote-only-group', { executionHostId: 'runtime:env-1' })
    const state = {
      ...getDefaultPersistedState('/home/test'),
      repos: [localRepo],
      projectGroups: [remoteGroup]
    }
    const scheduleSave = vi.fn()

    const moved = moveProjectToGroupInState(
      {
        state,
        scheduleSave,
        hydrateRepo: (repo) => repo
      },
      localRepo,
      'remote-only-group'
    )

    expect(moved).toMatchObject({
      id: 'shared-repo',
      projectGroupId: null
    })
    expect(localRepo.projectGroupId).toBeNull()
  })
})
