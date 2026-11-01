import { describe, expect, it } from 'vitest'
import { CONNECTOR_CLIENT_LIMITS } from '../../shared/connector-cloud-contract'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import { connectorProjects, placeLaunchTarget, type ConnectorPlacesStore } from './connector-places'

function repo(fields: Partial<Repo> & Pick<Repo, 'id'>): Repo {
  return {
    path: `/src/${fields.id}`,
    displayName: fields.id,
    badgeColor: '#000',
    addedAt: 1,
    ...fields
  }
}

function store(repos: Repo[], groups: Partial<ProjectGroup>[] = []): ConnectorPlacesStore {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connectorProjects reads only these fields of each group.
  const projectGroups = groups as ProjectGroup[]
  return {
    getRepos: () => repos,
    getProjectGroups: () => projectGroups,
    getFolderWorkspaces: () => [],
    getSshTargets: () => [
      { id: 'box', label: 'openclaw', host: 'openclaw', port: 22, username: 'me' }
    ],
    getProjectHostSetups: () => [],
    getAllWorktreeMeta: () => ({})
  }
}

describe('connector places', () => {
  it('names where each repo runs without paths, and keeps twins on other hosts apart', () => {
    const projects = connectorProjects(
      store([
        repo({
          id: 'orca',
          displayName: 'orca',
          gitRemoteIdentity: {
            canonicalKey: 'github.com/stablyai/orca',
            remoteName: 'origin',
            remoteUrl: 'git@github.com:stablyai/orca.git'
          }
        }),
        repo({ id: 'orca', connectionId: 'box', executionHostId: 'ssh:box' }),
        repo({ id: 'linux', path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\linux' }),
        repo({ id: 'served', executionHostId: 'runtime:server-1' }),
        repo({ id: 'notes', kind: 'folder' })
      ])
    )
    expect(projects.map(({ name, remote, where }) => ({ name, remote, where }))).toEqual([
      { name: 'orca', remote: 'stablyai/orca', where: { kind: 'local' } },
      { name: 'orca', remote: undefined, where: { kind: 'ssh', label: 'openclaw' } },
      { name: 'linux', remote: undefined, where: { kind: 'wsl', label: 'Ubuntu' } }
    ])
    expect(JSON.stringify(projects)).not.toContain('/src/')
    const [local, remote] = projects
    expect(placeLaunchTarget(local!.placeId, 'T1:C9:1', 'slack')).toEqual({
      kind: 'create-worktree',
      create: {
        repo: 'id:orca',
        repoHostId: 'local',
        name: expect.stringMatching(/^slack-[0-9a-f]{8}$/),
        nameWasGenerated: true
      }
    })
    expect(placeLaunchTarget(remote!.placeId, 'T1:C9:1', 'slack')).toMatchObject({
      create: { repo: 'id:orca', repoHostId: 'ssh:box' }
    })
  })

  it('starts folder projects as fresh folder workspaces', () => {
    const [folder] = connectorProjects(
      store(
        [],
        [
          { id: 'g1', name: 'Docs', parentPath: '/docs' },
          { id: 'g2', name: 'Group', parentPath: null }
        ]
      )
    )
    expect(folder).toMatchObject({ name: 'Docs', kind: 'folder', where: { kind: 'local' } })
    expect(placeLaunchTarget(folder!.placeId, 'd1', 'slack')).toEqual({
      kind: 'create-folder-workspace',
      create: { projectGroupId: 'g1', name: expect.stringMatching(/^slack-[0-9a-f]{8}$/) }
    })
  })

  it('derives the same worktree name for a resent start, and refuses a place it cannot read', () => {
    const [project] = connectorProjects(store([repo({ id: 'orca' })]))
    expect(placeLaunchTarget(project!.placeId, 'd1', 'slack')).toEqual(
      placeLaunchTarget(project!.placeId, 'd1', 'slack')
    )
    expect(placeLaunchTarget(project!.placeId, 'd1', 'slack')).not.toEqual(
      placeLaunchTarget(project!.placeId, 'd2', 'slack')
    )
    expect(placeLaunchTarget('not-a-place', 'd1', 'slack')).toBeNull()
    // The workspace is named for where the conversation came from.
    expect(placeLaunchTarget(project!.placeId, 'd1', 'linear')).toMatchObject({
      create: { name: expect.stringMatching(/^linear-[0-9a-f]{8}$/) }
    })
  })

  it('lists the most recently used projects first, at most maxHelloProjects, with short names', () => {
    const repos = Array.from({ length: CONNECTOR_CLIENT_LIMITS.maxHelloProjects + 1 }, (_, index) =>
      repo({ id: `r${index}`, addedAt: index, displayName: 'n'.repeat(300) })
    )
    const projects = connectorProjects({
      ...store(repos),
      getAllWorktreeMeta: () => ({
        'r0::/src/r0': {
          displayName: 'r0',
          comment: '',
          linkedIssue: null,
          linkedPR: null,
          linkedLinearIssue: null,
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 10_000
        }
      })
    })
    expect(projects).toHaveLength(CONNECTOR_CLIENT_LIMITS.maxHelloProjects)
    expect(projects[0]?.name).toHaveLength(CONNECTOR_CLIENT_LIMITS.maxDisplayTextLength)
    expect(projects[0]?.placeId).toBe(connectorProjects(store([repos[0]!]))[0]?.placeId)
  })
})
