import { describe, expect, it } from 'vitest'
import { LoadedCohortMigrationOperations } from './loaded-cohort-migrations'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { getDefaultPersistedState } from '../../../shared/constants'

function createRuntime() {
  return { loadNeedsSave: false }
}

function baseState(overrides: Partial<PersistedState> = {}): PersistedState {
  return { ...getDefaultPersistedState('/home/user'), ...overrides }
}

describe('LoadedCohortMigrationOperations.migrateWorkspaceTrust', () => {
  it('grandfathers every local repo and folder workspace as trusted, once', () => {
    const runtime = createRuntime()
    const cohorts = new LoadedCohortMigrationOperations(runtime)
    const state = baseState({
      repos: [
        {
          id: 'r1',
          path: '/home/user/work/repo-a',
          displayName: 'repo-a',
          badgeColor: '#fff',
          addedAt: 1
        }
      ],
      folderWorkspaces: [
        {
          id: 'f1',
          projectGroupId: 'g1',
          name: 'folder-a',
          folderPath: '/home/user/work/folder-a',
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
      ]
    })

    const migrated = cohorts.migrateWorkspaceTrust(state, true)

    expect(migrated.settings?.workspaceTrustMigratedExistingWorkspaces).toBe(true)
    expect(migrated.settings?.workspaceTrustEntries).toEqual([
      expect.objectContaining({
        path: '/home/user/work/repo-a',
        trusted: true,
        origin: 'migration'
      }),
      expect.objectContaining({
        path: '/home/user/work/folder-a',
        trusted: true,
        origin: 'migration'
      })
    ])
    expect(runtime.loadNeedsSave).toBe(true)
  })

  it('never re-fires once the marker is set', () => {
    const runtime = createRuntime()
    const cohorts = new LoadedCohortMigrationOperations(runtime)
    const alreadyMigrated = baseState({
      repos: [
        {
          id: 'r1',
          path: '/home/user/work/repo-a',
          displayName: 'a',
          badgeColor: '#fff',
          addedAt: 1
        }
      ],
      settings: {
        ...getDefaultPersistedState('/home/user').settings,
        workspaceTrustMigratedExistingWorkspaces: true,
        workspaceTrustEntries: []
      }
    })

    const migrated = cohorts.migrateWorkspaceTrust(alreadyMigrated, true)

    expect(migrated).toBe(alreadyMigrated)
    expect(runtime.loadNeedsSave).toBe(false)
  })

  it('sets the marker with no entries on a fresh install', () => {
    const runtime = createRuntime()
    const cohorts = new LoadedCohortMigrationOperations(runtime)
    const freshState = baseState({
      repos: [
        {
          id: 'r1',
          path: '/home/user/work/repo-a',
          displayName: 'a',
          badgeColor: '#fff',
          addedAt: 1
        }
      ]
    })

    const migrated = cohorts.migrateWorkspaceTrust(freshState, false)

    expect(migrated.settings?.workspaceTrustMigratedExistingWorkspaces).toBe(true)
    expect(migrated.settings?.workspaceTrustEntries).toEqual([])
  })

  it('excludes remote (connectionId set) repos and folder workspaces from grandfathering', () => {
    const runtime = createRuntime()
    const cohorts = new LoadedCohortMigrationOperations(runtime)
    const state = baseState({
      repos: [
        {
          id: 'r1',
          path: '/remote/repo',
          displayName: 'remote',
          badgeColor: '#fff',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      folderWorkspaces: []
    })

    const migrated = cohorts.migrateWorkspaceTrust(state, true)

    expect(migrated.settings?.workspaceTrustEntries).toEqual([])
  })
})
