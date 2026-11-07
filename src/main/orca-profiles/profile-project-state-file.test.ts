import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { Project } from '../../shared/project-types'
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
})
