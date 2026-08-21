import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import {
  MCODE_PROFILE_INDEX_SCHEMA_VERSION,
  type MCodeProfileIndex,
  type MCodeProfileKind
} from '../../shared/mcode-profiles'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { Repo } from '../../shared/repo-types'

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
  kind: MCodeProfileKind = 'local'
): MCodeProfileIndex['profiles'][number] {
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
  const index: MCodeProfileIndex = {
    schemaVersion: MCODE_PROFILE_INDEX_SCHEMA_VERSION,
    activeProfileId,
    profiles: [profile('personal', 'Personal'), profile('work', 'Work')]
  }
  writeFileSync(join(testState.dir, 'mcode-profile-index.json'), JSON.stringify(index), 'utf-8')
}

function writeProfileState(profileId: string, repos: Repo[]): void {
  const state: PersistedState = {
    ...getDefaultPersistedState('/Users/tester'),
    repos
  }
  const dataFile = join(testState.dir, 'profiles', profileId, 'mcode-data.json')
  mkdirSync(dirname(dataFile), { recursive: true })
  writeFileSync(dataFile, JSON.stringify(state), 'utf-8')
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/workspace/mcode',
    displayName: 'MCode',
    badgeColor: '#33aa99',
    addedAt: 100,
    kind: 'git',
    connectionId: null,
    ...overrides
  }
}

describe('profile project presence', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'mcode-profile-presence-'))
    writeIndex()
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('finds matching projects in other profiles while excluding the active profile', async () => {
    writeProfileState('personal', [
      makeRepo({ id: 'personal-repo', path: 'C:\\Code\\MCode', displayName: 'Personal MCode' })
    ])
    writeProfileState('work', [
      makeRepo({ id: 'work-repo', path: 'C:\\Code\\MCode', displayName: 'Work MCode' })
    ])

    const { findMCodeProfileProjectsByPath } = await loadPresenceModule()
    const result = findMCodeProfileProjectsByPath(
      {
        path: 'c:/code/mcode/',
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
        repoName: 'Work MCode'
      }
    ])
  })

  it('keeps SSH projects separate from local projects with the same path', async () => {
    writeProfileState('personal', [
      makeRepo({ id: 'local-repo', path: '/srv/mcode', displayName: 'Local MCode' })
    ])
    writeProfileState('work', [
      makeRepo({
        id: 'ssh-repo',
        path: '/srv/mcode',
        displayName: 'SSH MCode',
        connectionId: 'builder',
        executionHostId: 'ssh:builder'
      })
    ])

    const { findMCodeProfileProjectsByPath } = await loadPresenceModule()
    const result = findMCodeProfileProjectsByPath(
      {
        path: '/srv/mcode',
        connectionId: 'builder',
        executionHostId: 'ssh:builder'
      },
      testState.dir
    )

    expect(result.projects).toEqual([
      expect.objectContaining({
        profileId: 'work',
        repoId: 'ssh-repo',
        repoName: 'SSH MCode'
      })
    ])
  })
})
