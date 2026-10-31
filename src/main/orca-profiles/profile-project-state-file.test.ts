import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { Project, ProjectHostSetup } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import { rebuildRepoBackedProjectState } from './profile-project-state-file'
import { mergeProjectHostSetupCompatibilityState } from '../persistence/tracking-repos/project-host-compatibility'

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
  it('carries every retiring override into an existing destination on live synchronization and profile reload', () => {
    const destination = 'git:git.example.com/acme/app-upstream'
    for (const destinationMode of [undefined, 'host'] as const) {
      const state = makeState({
        repos: [
          makeRepo({ id: 'r1', gitRemoteIdentity: upstreamIdentity }),
          makeRepo({ id: 'r2', path: '/other', gitRemoteIdentity: upstreamIdentity })
        ],
        projects: [
          makeProject({
            id: 'repo:r1',
            sourceRepoIds: ['r1'],
            localWindowsRuntimePreference: { kind: 'windows-host' }
          }),
          makeProject({
            id: destination,
            sourceRepoIds: ['r2'],
            localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
          })
        ]
      })
      state.settings.projectGroupingOverrides = {
        'repo:r1': 'folder',
        offline: 'folder',
        ...(destinationMode ? { [destination]: destinationMode } : {})
      }
      for (const result of [
        mergeProjectHostSetupCompatibilityState(state, state.repos),
        rebuildRepoBackedProjectState(JSON.parse(JSON.stringify(state)))
      ]) {
        expect(result.settings?.projectGroupingOverrides).toEqual({
          [destination]: destinationMode ?? 'folder',
          offline: 'folder'
        })
        expect(result.projects).toHaveLength(1)
        expect(result.projects[0]).toMatchObject({
          id: destination,
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        })
        const reloaded = rebuildRepoBackedProjectState({ ...state, ...result })
        expect(reloaded.settings.projectGroupingOverrides).toEqual(
          result.settings?.projectGroupingOverrides
        )
      }
    }
  })

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
