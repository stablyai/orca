import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import {
  ORCA_PROFILE_INDEX_SCHEMA_VERSION,
  type OrcaProfileIndex,
  type OrcaProfileKind
} from '../../shared/orca-profiles'
import type { PersistedState, Repo } from '../../shared/types'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  }
}))

async function loadPresenceModule() {
  vi.resetModules()
  return import('./profile-project-presence')
}

function profile(
  id: string,
  name: string,
  kind: OrcaProfileKind = 'local'
): OrcaProfileIndex['profiles'][number] {
  return {
    id,
    name,
    avatar: { kind: 'initials', initials: name[0], color: 'neutral' },
    kind,
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1
  }
}

function writeIndex(activeProfileId = 'personal'): void {
  const index: OrcaProfileIndex = {
    schemaVersion: ORCA_PROFILE_INDEX_SCHEMA_VERSION,
    activeProfileId,
    profiles: [profile('personal', 'Personal'), profile('work', 'Work')]
  }
  writeFileSync(join(testState.dir, 'orca-profile-index.json'), JSON.stringify(index), 'utf-8')
}

function writeProfileState(profileId: string, repos: Repo[]): void {
  const state: PersistedState = {
    ...getDefaultPersistedState('/Users/tester'),
    repos
  }
  const dataFile = join(testState.dir, 'profiles', profileId, 'orca-data.json')
  mkdirSync(dirname(dataFile), { recursive: true })
  writeFileSync(dataFile, JSON.stringify(state), 'utf-8')
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/workspace/orca',
    displayName: 'Orca',
    badgeColor: '#33aa99',
    addedAt: 100,
    kind: 'git',
    connectionId: null,
    ...overrides
  }
}

describe('profile project presence', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-profile-presence-'))
    writeIndex()
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('finds matching projects in other profiles while excluding the active profile', async () => {
    writeProfileState('personal', [
      makeRepo({ id: 'personal-repo', path: 'C:\\Code\\Orca', displayName: 'Personal Orca' })
    ])
    writeProfileState('work', [
      makeRepo({ id: 'work-repo', path: 'C:\\Code\\Orca', displayName: 'Work Orca' })
    ])

    const { findOrcaProfileProjectsByPath } = await loadPresenceModule()
    const result = findOrcaProfileProjectsByPath(
      {
        path: 'c:/code/orca/',
        executionHostId: 'local',
        excludeProfileId: 'personal'
      },
      testState.dir
    )

    expect(result.projects).toEqual([
      {
        profileId: 'work',
        profileName: 'Work',
        profileKind: 'local',
        repoId: 'work-repo',
        repoName: 'Work Orca'
      }
    ])
  })

  it('keeps SSH projects separate from local projects with the same path', async () => {
    writeProfileState('personal', [
      makeRepo({ id: 'local-repo', path: '/srv/orca', displayName: 'Local Orca' })
    ])
    writeProfileState('work', [
      makeRepo({
        id: 'ssh-repo',
        path: '/srv/orca',
        displayName: 'SSH Orca',
        connectionId: 'builder',
        executionHostId: 'ssh:builder'
      })
    ])

    const { findOrcaProfileProjectsByPath } = await loadPresenceModule()
    const result = findOrcaProfileProjectsByPath(
      {
        path: '/srv/orca',
        connectionId: 'builder',
        executionHostId: 'ssh:builder'
      },
      testState.dir
    )

    expect(result.projects).toEqual([
      expect.objectContaining({
        profileId: 'work',
        repoId: 'ssh-repo',
        repoName: 'SSH Orca'
      })
    ])
  })
})
