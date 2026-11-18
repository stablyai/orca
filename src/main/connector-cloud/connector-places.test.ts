import { describe, expect, it } from 'vitest'

import type { ProjectGroup } from '../../shared/project/groups/project-group-types'
import type { Repo } from '../../shared/repository/repo-types'
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
})
