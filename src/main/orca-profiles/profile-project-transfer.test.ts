import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import {
  ORCA_PROFILE_INDEX_SCHEMA_VERSION,
  type OrcaProfileIndex
} from '../../shared/orca-profiles'
import type { PersistedState, Repo, WorktreeMeta } from '../../shared/types'
import type { SshTarget } from '../../shared/ssh-types'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  }
}))

async function loadTransferModule() {
  vi.resetModules()
  return import('./profile-project-transfer')
}

function profile(id: string, name: string): OrcaProfileIndex['profiles'][number] {
  return {
    id,
    name,
    avatar: { kind: 'initials', initials: name[0], color: 'neutral' },
    kind: 'local',
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

function profileDataPath(profileId: string): string {
  return join(testState.dir, 'profiles', profileId, 'orca-data.json')
}

function writeProfileState(profileId: string, state: PersistedState): void {
  const dataFile = profileDataPath(profileId)
  mkdirSync(join(dataFile, '..'), { recursive: true })
  writeFileSync(dataFile, JSON.stringify(state, null, 2), 'utf-8')
}

function readProfileState(profileId: string): PersistedState {
  return JSON.parse(readFileSync(profileDataPath(profileId), 'utf-8')) as PersistedState
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

function makeWorktreeMeta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    displayName: 'Feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 10,
    lastActivityAt: 123,
    ...overrides
  }
}

function makeState(overrides: Partial<PersistedState> = {}): PersistedState {
  const defaults = getDefaultPersistedState('/Users/tester')
  return {
    ...defaults,
    ...overrides,
    settings: { ...defaults.settings, ...overrides.settings },
    ui: { ...defaults.ui, ...overrides.ui },
    workspaceSession: { ...defaults.workspaceSession, ...overrides.workspaceSession }
  }
}

describe('profile project transfer', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-profile-transfer-'))
    writeIndex()
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('copies a project into another profile with a new repo id and re-keyed metadata', async () => {
    const sourceWorktreeId = 'repo-1::/workspace/orca-feature'
    writeProfileState(
      'personal',
      makeState({
        repos: [makeRepo()],
        sparsePresetsByRepo: {
          'repo-1': [
            {
              id: 'preset-1',
              repoId: 'repo-1',
              name: 'UI',
              directories: ['src/renderer'],
              createdAt: 1,
              updatedAt: 1
            }
          ]
        },
        worktreeMeta: {
          [sourceWorktreeId]: makeWorktreeMeta({ projectHostSetupId: 'repo-1' })
        },
        workspaceSession: {
          ...getDefaultPersistedState('/Users/tester').workspaceSession,
          tabsByWorktree: {
            [sourceWorktreeId]: [
              {
                id: 'tab-1',
                ptyId: 'pty-1',
                worktreeId: sourceWorktreeId,
                title: 'Terminal',
                customTitle: null,
                color: null,
                sortOrder: 0,
                createdAt: 1
              }
            ]
          }
        }
      })
    )
    writeProfileState('work', makeState())

    const { transferOrcaProfileProject } = await loadTransferModule()
    const result = transferOrcaProfileProject(
      {
        sourceProfileId: 'personal',
        targetProfileId: 'work',
        repoId: 'repo-1',
        mode: 'copy'
      },
      testState.dir
    )

    expect(result.status).toBe('transferred')
    expect(result.status === 'transferred' ? result.targetRepoId : '').not.toBe('repo-1')
    const targetRepoId = result.status === 'transferred' ? result.targetRepoId : ''
    const target = readProfileState('work')
    const targetWorktreeId = `${targetRepoId}::/workspace/orca-feature`
    expect(target.repos).toEqual([
      expect.objectContaining({ id: targetRepoId, path: '/workspace/orca' })
    ])
    expect(target.worktreeMeta[targetWorktreeId]).toMatchObject({
      displayName: 'Feature',
      projectHostSetupId: targetRepoId,
      hostId: 'local'
    })
    expect(target.sparsePresetsByRepo[targetRepoId]).toEqual([
      expect.objectContaining({ id: 'preset-1', repoId: targetRepoId })
    ])
    expect(target.workspaceSession.tabsByWorktree).toEqual({})
    expect(readProfileState('personal').repos.map((repo) => repo.id)).toEqual(['repo-1'])
  })

  it('moves a project, preserving SSH identity and restorable workspace session state', async () => {
    const sourceWorktreeId = 'repo-ssh::/srv/orca-feature'
    const sshTarget: SshTarget = {
      id: 'ssh-1',
      label: 'Builder',
      host: 'builder.example.com',
      port: 22,
      username: 'dev'
    }
    writeProfileState(
      'personal',
      makeState({
        repos: [
          makeRepo({
            id: 'repo-ssh',
            path: '/srv/orca',
            connectionId: 'ssh-1',
            executionHostId: 'ssh:ssh-1'
          })
        ],
        sshTargets: [sshTarget],
        worktreeMeta: {
          [sourceWorktreeId]: makeWorktreeMeta({ projectHostSetupId: 'repo-ssh' })
        },
        workspaceSession: {
          ...getDefaultPersistedState('/Users/tester').workspaceSession,
          browserTabsByWorktree: {
            [sourceWorktreeId]: [
              {
                id: 'browser-1',
                worktreeId: sourceWorktreeId,
                sessionProfileId: 'source-browser-profile',
                sessionPartition: 'persist:orca-profile-personal-deadbeef-browser-default',
                url: 'https://example.com',
                title: 'Example',
                loading: false,
                faviconUrl: null,
                canGoBack: false,
                canGoForward: false,
                loadError: null,
                createdAt: 1
              }
            ]
          }
        }
      })
    )
    writeProfileState('work', makeState())

    const { transferOrcaProfileProject } = await loadTransferModule()
    const result = transferOrcaProfileProject(
      {
        sourceProfileId: 'personal',
        targetProfileId: 'work',
        repoId: 'repo-ssh',
        mode: 'move'
      },
      testState.dir
    )

    expect(result).toMatchObject({
      status: 'transferred',
      sourceRepoId: 'repo-ssh',
      targetRepoId: 'repo-ssh'
    })
    const source = readProfileState('personal')
    const target = readProfileState('work')
    expect(source.repos).toEqual([])
    expect(source.worktreeMeta).toEqual({})
    expect(target.repos[0]).toMatchObject({
      id: 'repo-ssh',
      path: '/srv/orca',
      connectionId: 'ssh-1',
      executionHostId: 'ssh:ssh-1'
    })
    expect(target.sshTargets).toEqual([sshTarget])
    expect(target.workspaceSession.browserTabsByWorktree?.[sourceWorktreeId]?.[0]).toMatchObject({
      worktreeId: sourceWorktreeId,
      sessionProfileId: null,
      sessionPartition: null
    })
  })

  it('rejects a duplicate physical project inside the target profile', async () => {
    writeProfileState(
      'personal',
      makeState({
        repos: [makeRepo({ path: 'C:\\Work\\Orca\\' })]
      })
    )
    writeProfileState(
      'work',
      makeState({
        repos: [makeRepo({ id: 'repo-existing', path: 'c:/work/orca' })]
      })
    )

    const { transferOrcaProfileProject } = await loadTransferModule()
    const result = transferOrcaProfileProject(
      {
        sourceProfileId: 'personal',
        targetProfileId: 'work',
        repoId: 'repo-1',
        mode: 'copy'
      },
      testState.dir
    )

    expect(result).toEqual({
      status: 'duplicate-target',
      sourceProfileId: 'personal',
      targetProfileId: 'work',
      sourceRepoId: 'repo-1',
      duplicateRepoId: 'repo-existing'
    })
    expect(readProfileState('work').repos.map((repo) => repo.id)).toEqual(['repo-existing'])
  })
})
