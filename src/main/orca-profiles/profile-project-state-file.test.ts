import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { Project, ProjectHostSetup } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import { mergeProjectHostSetupCompatibilityState } from '../persistence/tracking-repos/project-host-compatibility'
import { projectHostSetupProjectionFromRepos } from '../../shared/project-host-setup-projection'
import { rebuildRepoBackedProjectState } from './profile-project-state-file'

const upstreamIdentity = {
  canonicalKey: 'git.example.com/acme/app-upstream',
  remoteName: 'upstream',
  remoteUrl: 'git@git.example.com:acme/app-upstream.git'
}

const makeRepo = (overrides: Partial<Repo> = {}): Repo => ({
  id: 'r1',
  path: '/repo',
  displayName: 'App',
  badgeColor: '#fff',
  addedAt: 1,
  ...overrides
})

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  displayName: 'App',
  badgeColor: '#737373',
  sourceRepoIds: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const makeSetup = (overrides: Partial<ProjectHostSetup> = {}): ProjectHostSetup => ({
  id: 'setup-1',
  projectId: 'project-1',
  hostId: 'local',
  repoId: '',
  path: '/repo',
  displayName: 'App',
  setupState: 'ready',
  setupMethod: 'imported-existing-folder',
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

function makeState(overrides: Partial<PersistedState>): PersistedState {
  return { ...getDefaultPersistedState('/home/test'), ...overrides }
}

describe('rebuildRepoBackedProjectState', () => {
  it('carries project state and independent setups across a repo remote identity change', () => {
    const originProjectId = 'git:git.example.com/acme/app'
    const rebuilt = rebuildRepoBackedProjectState(
      makeState({
        repos: [makeRepo({ gitRemoteIdentity: upstreamIdentity })],
        projects: [
          makeProject({
            id: originProjectId,
            sourceRepoIds: ['r1'],
            localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
          })
        ],
        projectHostSetups: [
          makeSetup({ id: 'r1', projectId: originProjectId, repoId: 'r1' }),
          makeSetup({
            id: 'app::gpu-vm',
            projectId: originProjectId,
            hostId: 'runtime:gpu-vm',
            path: '/srv/app'
          })
        ]
      })
    )

    expect(rebuilt.projects).toEqual([
      expect.objectContaining({
        id: 'git:git.example.com/acme/app-upstream',
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      })
    ])
    expect(rebuilt.projectHostSetups.find((setup) => setup.id === 'app::gpu-vm')?.projectId).toBe(
      'git:git.example.com/acme/app-upstream'
    )
  })

  it('leaves an unclaimed prior project standing with its own independent setups', () => {
    const rebuilt = rebuildRepoBackedProjectState(
      makeState({
        repos: [makeRepo({ gitRemoteIdentity: upstreamIdentity })],
        projects: [
          makeProject({
            id: 'cloud-project',
            localWindowsRuntimePreference: { kind: 'windows-host' }
          })
        ],
        projectHostSetups: [
          makeSetup({ id: 'cloud-project::gpu-vm', projectId: 'cloud-project', path: '/srv/cloud' })
        ]
      })
    )

    expect(rebuilt.projects.map((project) => project.id)).toEqual([
      'git:git.example.com/acme/app-upstream',
      'cloud-project'
    ])
    expect(rebuilt.projectHostSetups.map((setup) => setup.projectId)).toEqual([
      'git:git.example.com/acme/app-upstream',
      'cloud-project'
    ])
  })
})

it('reconciles and reloads split and ordinary handoff choices consistently with profile rebuilding', () => {
  const projectId = 'github:acme/app'
  const repos = [
    makeRepo({ id: 'a', path: 'C:/a', addedAt: 1, upstream: { owner: 'acme', repo: 'app' } }),
    makeRepo({ id: 'b', path: 'C:/b', addedAt: 2, upstream: { owner: 'acme', repo: 'app' } }),
    makeRepo({
      id: 'c',
      path: '/srv/c',
      executionHostId: 'runtime:remote',
      upstream: { owner: 'acme', repo: 'app' }
    })
  ]
  const projection = projectHostSetupProjectionFromRepos(repos)
  const previous = makeState({
    repos,
    projects: [
      makeProject({
        id: projectId,
        sourceRepoIds: ['a', 'b', 'c'],
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      })
    ],
    projectHostSetups: [
      ...projection.setups.map((setup) => ({ ...setup, projectId })),
      makeSetup({
        id: 'pending-b',
        projectId: 'repo:b',
        hostId: 'ssh:extra',
        path: '',
        setupState: 'not-set-up',
        setupMethod: 'provisioned'
      })
    ]
  })
  const split = { ...previous, ...mergeProjectHostSetupCompatibilityState(previous, repos) }
  expect(
    split.projects.find((project) => project.id === 'repo:b')?.localWindowsRuntimePreference
  ).toEqual({ kind: 'wsl', distro: 'Ubuntu' })
  expect(rebuildRepoBackedProjectState(previous).projects).toEqual(split.projects)
  for (const preference of [undefined, { kind: 'windows-host' as const }]) {
    const saved = {
      ...split,
      projectHostSetups: split.projectHostSetups.map((setup) =>
        setup.id === 'pending-b' ? { ...setup, projectId: 'repo:b' } : setup
      ),
      projects: split.projects.map((project) =>
        project.id === 'repo:b'
          ? { ...project, localWindowsRuntimePreference: preference }
          : project
      )
    }
    const reloaded = JSON.parse(JSON.stringify(saved))
    const remaining = repos.filter((repo) => repo.id !== 'a')
    const handedOff = mergeProjectHostSetupCompatibilityState(reloaded, remaining)
    expect(
      handedOff.projects.find((project) => project.id === projectId)?.localWindowsRuntimePreference
    ).toEqual(preference)
    expect(handedOff.projectHostSetups?.filter((setup) => setup.id === 'pending-b')).toEqual([
      expect.objectContaining({
        projectId,
        hostId: 'ssh:extra',
        repoId: '',
        setupState: 'not-set-up',
        setupMethod: 'provisioned'
      })
    ])
    expect(
      rebuildRepoBackedProjectState({ ...reloaded, repos: remaining }).projectHostSetups
    ).toEqual(handedOff.projectHostSetups)
    expect(rebuildRepoBackedProjectState({ ...reloaded, repos: remaining }).projects).toEqual(
      handedOff.projects
    )
    expect(
      mergeProjectHostSetupCompatibilityState(JSON.parse(JSON.stringify(handedOff)), remaining)
    ).toEqual(handedOff)
  }
})
