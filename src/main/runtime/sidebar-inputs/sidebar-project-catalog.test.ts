import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../shared/project-group-types'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import type { Repo } from '../../../shared/repo-types'
import {
  readSidebarProjectCatalog,
  type SidebarProjectCatalogStore
} from './sidebar-project-catalog'

function repo(id: string, extra: Partial<Repo> = {}): Repo {
  return { id, path: `/p/${id}`, displayName: id, badgeColor: 'blue', addedAt: 1, ...extra }
}

function group(id: string, extra: Partial<ProjectGroup> = {}): ProjectGroup {
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
    ...extra
  }
}

function store(repos: Repo[], groups: ProjectGroup[]): SidebarProjectCatalogStore {
  return {
    getRepos: () => repos,
    getProjectGroups: () => groups,
    getFolderWorkspaces: () => [],
    getSshTargets: () => [],
    getProjectHostSetups: () => [],
    getProjects: () => [],
    getUI: () => ({
      projectOrderBy: 'manual',
      manualRepoOrder: [
        { hostId: 'runtime:hub', repoId: 'hub-repo' },
        { hostId: 'local', repoId: 'b' }
      ]
    })
  }
}

describe('readSidebarProjectCatalog', () => {
  it("lists this host's and each paired server's repos and groups, stamped and in manual order", () => {
    const hubRepo = repo('hub-repo', { executionHostId: 'runtime:hub', projectGroupId: 'hub-g' })
    const catalog = readSidebarProjectCatalog(
      store(
        [
          repo('a', { projectGroupId: 'school', projectGroupOrder: 2 }),
          repo('b'),
          repo('s', { connectionId: 'box' }),
          repo('upload', {
            repoIcon: { type: 'image', src: 'data:image/png;base64,AA', source: 'upload' }
          })
        ],
        [group('school'), group('remote', { connectionId: 'box', parentGroupId: 'school' })]
      ),
      [
        {
          hostId: 'runtime:hub',
          repos: [hubRepo],
          projectGroups: [group('hub-g', { executionHostId: 'runtime:hub' })],
          projection: projectHostSetupProjectionFromRepos([hubRepo])
        }
      ]
    )

    expect(catalog.repos.map((entry) => `${entry.executionHostId}|${entry.id}`)).toEqual([
      'runtime:hub|hub-repo',
      'local|b',
      'local|a',
      'ssh:box|s',
      'local|upload'
    ])
    expect(catalog.repos.find((entry) => entry.id === 'a')).toMatchObject({
      projectGroupId: 'school',
      projectGroupOrder: 2
    })
    // An uploaded icon is a data URL a phone reads through sidebarInputs.repoIcons instead.
    expect(catalog.repos.find((entry) => entry.id === 'upload')).not.toHaveProperty('repoIcon')
    expect(catalog.projectGroups?.map((entry) => [entry.id, entry.executionHostId])).toEqual([
      ['school', 'local'],
      ['remote', 'ssh:box'],
      ['hub-g', 'runtime:hub']
    ])
    expect(catalog.setups.map((setup) => [setup.repoId, setup.hostId]).sort()).toEqual([
      ['a', 'local'],
      ['b', 'local'],
      ['hub-repo', 'runtime:hub'],
      ['s', 'ssh:box'],
      ['upload', 'local']
    ])
    expect(catalog.projectOrderBy).toBe('manual')
  })

  it("files a server's copy of a grouped project under that group, as the window does", () => {
    const upstream = { owner: 'stablyai', repo: 'school-app' }
    const copy = repo('copy', { executionHostId: 'runtime:hub', upstream })
    const catalog = readSidebarProjectCatalog(
      store([repo('a', { projectGroupId: 'school', upstream })], [group('school')]),
      [
        {
          hostId: 'runtime:hub',
          repos: [copy],
          projectGroups: [],
          projection: projectHostSetupProjectionFromRepos([copy])
        }
      ]
    )
    expect(catalog.repos.map((entry) => [entry.id, entry.projectGroupId])).toEqual([
      ['a', 'school'],
      ['copy', 'school']
    ])
  })
})
