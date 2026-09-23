import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import {
  ORCA_PROFILE_INDEX_SCHEMA_VERSION,
  type OrcaProfileIndex
} from '../../shared/orca-profiles'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { SshTarget } from '../../shared/ssh-types'
import {
  exportProfileStateJson,
  hashProfileStateJson,
  importProfileStateJson
} from '../persistence/profile-state/profile-state-documents'
import { openProfileStateDatabase } from '../persistence/profile-state/profile-state-database'
import {
  persistProfileProjectMoveIntent,
  recoverPendingProfileProjectMoves,
  type ProfileProjectMoveIntent
} from './profile-project-move-intent'
import type { ReadProfileStateResult } from './profile-project-state-file'

function createProfileProjectMoveIntent(args: {
  sourceProfileId: string
  targetProfileId: string
  source: ReadProfileStateResult
  target: ReadProfileStateResult
  sourceAfterJson: string
  targetAfterJson: string
}): Extract<ProfileProjectMoveIntent, { version: 1 }> {
  if (
    args.source.revision === undefined ||
    args.target.revision === undefined ||
    args.source.serialized === undefined ||
    args.target.serialized === undefined
  ) {
    throw new Error('Legacy move fixture requires two serialized SQLite snapshots')
  }
  return {
    version: 1,
    id: '11111111-1111-1111-1111-111111111111',
    sourceProfileId: args.sourceProfileId,
    targetProfileId: args.targetProfileId,
    expectedSourceRevision: args.source.revision,
    expectedTargetRevision: args.target.revision,
    sourceBeforeHash: hashProfileStateJson(args.source.serialized),
    targetBeforeHash: hashProfileStateJson(args.target.serialized),
    sourceAfterHash: hashProfileStateJson(args.sourceAfterJson),
    targetAfterHash: hashProfileStateJson(args.targetAfterJson),
    sourceAfterJson: args.sourceAfterJson,
    targetAfterJson: args.targetAfterJson
  }
}

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

function profileDatabasePath(profileId: string): string {
  return join(testState.dir, 'profiles', profileId, 'profile-state.db')
}

function writeProfileState(profileId: string, state: PersistedState): void {
  const dataFile = profileDataPath(profileId)
  mkdirSync(join(dataFile, '..'), { recursive: true })
  writeFileSync(dataFile, JSON.stringify(state, null, 2), 'utf-8')
}

function writeProfileStateDatabase(profileId: string, state: PersistedState): void {
  const databasePath = profileDatabasePath(profileId)
  mkdirSync(join(databasePath, '..'), { recursive: true })
  const opened = openProfileStateDatabase(databasePath, profileId)
  try {
    importProfileStateJson(opened.db, JSON.stringify(state))
  } finally {
    opened.db.close()
  }
}

function writeProfileStateDatabaseWithAcceptedLegacyJson(profileId: string, rawJson: string): void {
  const databasePath = profileDatabasePath(profileId)
  mkdirSync(join(databasePath, '..'), { recursive: true })
  const opened = openProfileStateDatabase(databasePath, profileId)
  try {
    importProfileStateJson(opened.db, rawJson, {
      acceptedLegacyJsonHash: hashProfileStateJson(rawJson)
    })
  } finally {
    opened.db.close()
  }
}

function readProfileStateDatabase(profileId: string): PersistedState {
  const opened = openProfileStateDatabase(profileDatabasePath(profileId), profileId)
  try {
    return JSON.parse(exportProfileStateJson(opened.db))
  } finally {
    opened.db.close()
  }
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
        retiredWorktreeNamesByRepo: { 'repo-1': { exhaustedTiers: 0, names: ['nautilus'] } },
        retiredWorktreeNamesByNamespace: {
          'ssh:ssh-1:/workspace/orca-nautilus': { exhaustedTiers: 0, names: ['seahorse'] }
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
    // Why: without the re-key the destination profile reissues a name whose old directory may
    // still hold the previous occupant's agent conversation.
    expect(target.retiredWorktreeNamesByRepo?.[targetRepoId]).toEqual({
      exhaustedTiers: 0,
      names: ['nautilus']
    })
    expect(target.retiredWorktreeNamesByNamespace).toEqual({})
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
        retiredWorktreeNamesByNamespace: {
          'ssh:ssh-1:posix:/srv/orca-orca-retirement-probe': {
            exhaustedTiers: 0,
            names: ['seahorse']
          }
        },
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
    // The source key predates endpoint identity; the transfer folds it onto the canonical one.
    expect(target.retiredWorktreeNamesByNamespace).toEqual({
      'ssh:builder.example.com|22|dev:posix:/srv/orca-orca-retirement-probe': {
        exhaustedTiers: 0,
        names: ['seahorse']
      }
    })
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

  it('transfers between SQLite-backed profiles without creating legacy JSON or touching sidecars', async () => {
    const sourceState = makeState({ repos: [makeRepo()] })
    writeProfileStateDatabase('personal', sourceState)
    writeProfileStateDatabase('work', makeState())
    const sidecarPath = join(testState.dir, 'profiles', 'work', 'browser-session-meta.json')
    writeFileSync(sidecarPath, '{"preserve":true}', 'utf-8')

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
    expect(readProfileStateDatabase('work').repos).toEqual([
      expect.objectContaining({ path: '/workspace/orca' })
    ])
    expect(existsSync(profileDataPath('personal'))).toBe(false)
    expect(existsSync(profileDataPath('work'))).toBe(false)
    expect(readFileSync(sidecarPath, 'utf-8')).toBe('{"preserve":true}')
  })

  it('keeps the legacy JSON backend when neither profile has a database', async () => {
    writeProfileState('personal', makeState({ repos: [makeRepo()] }))
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
    expect(readProfileState('work').repos).toEqual([
      expect.objectContaining({ path: '/workspace/orca' })
    ])
    expect(existsSync(profileDatabasePath('personal'))).toBe(false)
    expect(existsSync(profileDatabasePath('work'))).toBe(false)
  })

  it('fails closed when a profile has both database and legacy JSON state', async () => {
    const sourceState = makeState({ repos: [makeRepo()] })
    writeProfileState('personal', sourceState)
    writeProfileStateDatabase('personal', sourceState)
    writeProfileState('work', makeState())

    const { transferOrcaProfileProject } = await loadTransferModule()
    expect(() =>
      transferOrcaProfileProject(
        {
          sourceProfileId: 'personal',
          targetProfileId: 'work',
          repoId: 'repo-1',
          mode: 'copy'
        },
        testState.dir
      )
    ).toThrowError(expect.objectContaining({ code: 'ambiguous_profile_state_storage' }))
  })

  it('uses SQLite when the retained legacy JSON is the accepted migration export', async () => {
    const sourceState = makeState({ repos: [makeRepo()] })
    writeProfileState('personal', sourceState)
    const sourceJson = readFileSync(profileDataPath('personal'), 'utf-8')
    writeProfileStateDatabaseWithAcceptedLegacyJson('personal', sourceJson)
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
    expect(readProfileStateDatabase('work').repos).toEqual([
      expect.objectContaining({ path: '/workspace/orca' })
    ])
    expect(readFileSync(profileDataPath('personal'), 'utf-8')).toBe(sourceJson)
    expect(readProfileStateDatabase('personal').repos).toEqual([
      expect.objectContaining({ path: '/workspace/orca' })
    ])
  })

  it('rejects a missing SQLite database when a retained export proves JSON is stale', async () => {
    const sourceState = makeState({ repos: [makeRepo()] })
    writeProfileState('personal', sourceState)
    const sourceJson = readFileSync(profileDataPath('personal'), 'utf-8')
    writeProfileStateDatabaseWithAcceptedLegacyJson('personal', sourceJson)
    rmSync(profileDatabasePath('personal'))
    writeFileSync(`${profileDataPath('personal')}.sqlite-export.1.json`, sourceJson)
    writeProfileState('work', makeState())

    const { transferOrcaProfileProject } = await loadTransferModule()
    expect(() =>
      transferOrcaProfileProject(
        {
          sourceProfileId: 'personal',
          targetProfileId: 'work',
          repoId: 'repo-1',
          mode: 'copy'
        },
        testState.dir
      )
    ).toThrowError(expect.objectContaining({ code: 'profile-state-recovery-required' }))
  })

  it.each(['-wal', '-shm', '-journal'])(
    'refuses a transfer from an orphaned %s',
    async (suffix) => {
      writeProfileState('personal', makeState({ repos: [makeRepo()] }))
      writeProfileState('work', makeState())
      const sourceJson = readFileSync(profileDataPath('personal'), 'utf8')
      const targetJson = readFileSync(profileDataPath('work'), 'utf8')
      const sidecar = `${profileDatabasePath('personal')}${suffix}`
      writeFileSync(sidecar, 'orphaned recovery evidence')

      const { transferOrcaProfileProject } = await loadTransferModule()
      expect(() =>
        transferOrcaProfileProject(
          { sourceProfileId: 'personal', targetProfileId: 'work', repoId: 'repo-1', mode: 'move' },
          testState.dir
        )
      ).toThrow()
      expect(readFileSync(profileDataPath('personal'), 'utf8')).toBe(sourceJson)
      expect(readFileSync(profileDataPath('work'), 'utf8')).toBe(targetJson)
      expect(readFileSync(sidecar, 'utf8')).toBe('orphaned recovery evidence')
      expect(existsSync(profileDatabasePath('personal'))).toBe(false)
      expect(existsSync(profileDatabasePath('work'))).toBe(false)
    }
  )

  it.each(['copy', 'move'] as const)(
    '%s transfers between SQLite-only profiles while retaining rollback exports',
    async (mode) => {
      const sourceState = makeState({ repos: [makeRepo()] })
      const targetState = makeState()
      writeProfileStateDatabase('personal', sourceState)
      writeProfileStateDatabase('work', targetState)
      const sourceExport = JSON.stringify(sourceState)
      const targetExport = JSON.stringify(targetState)
      const sourceExportPath = `${profileDataPath('personal')}.sqlite-export.1.json`
      const targetExportPath = `${profileDataPath('work')}.sqlite-export.1.json`
      writeFileSync(sourceExportPath, sourceExport)
      writeFileSync(targetExportPath, targetExport)

      const { transferOrcaProfileProject } = await loadTransferModule()
      const result = transferOrcaProfileProject(
        {
          sourceProfileId: 'personal',
          targetProfileId: 'work',
          repoId: 'repo-1',
          mode
        },
        testState.dir
      )

      expect(result.status).toBe('transferred')
      expect(readProfileStateDatabase('personal').repos).toHaveLength(mode === 'move' ? 0 : 1)
      expect(readProfileStateDatabase('work').repos).toEqual([
        expect.objectContaining({ path: '/workspace/orca' })
      ])
      expect(existsSync(profileDataPath('personal'))).toBe(false)
      expect(existsSync(profileDataPath('work'))).toBe(false)
      expect(readFileSync(sourceExportPath, 'utf8')).toBe(sourceExport)
      expect(readFileSync(targetExportPath, 'utf8')).toBe(targetExport)
    }
  )

  it('fences a SQLite transfer write against the revision that was read', async () => {
    writeProfileStateDatabase('work', makeState())

    await loadTransferModule()
    const stateFile = await import('./profile-project-state-file')
    const observed = stateFile.readProfileStateWithRevision('work', testState.dir)
    expect(observed.revision).toBeGreaterThan(0)

    const opened = openProfileStateDatabase(profileDatabasePath('work'), 'work')
    try {
      importProfileStateJson(
        opened.db,
        JSON.stringify(makeState({ settings: { ...makeState().settings, theme: 'dark' } }))
      )
    } finally {
      opened.db.close()
    }

    expect(() =>
      stateFile.writeProfileState('work', testState.dir, makeState(), {
        expectedRevision: observed.revision
      })
    ).toThrowError(expect.objectContaining({ code: 'profile-state-revision-conflict' }))
    expect(readProfileStateDatabase('work').settings.theme).toBe('dark')
  })

  it('moves between SQLite-backed profiles through a durable cross-profile intent', async () => {
    writeProfileStateDatabase('personal', makeState({ repos: [makeRepo()] }))
    writeProfileStateDatabase('work', makeState())

    const { transferOrcaProfileProject } = await loadTransferModule()
    const result = transferOrcaProfileProject(
      {
        sourceProfileId: 'personal',
        targetProfileId: 'work',
        repoId: 'repo-1',
        mode: 'move'
      },
      testState.dir
    )
    expect(result.status).toBe('transferred')
    expect(readProfileStateDatabase('personal').repos).toHaveLength(0)
    expect(readProfileStateDatabase('work').repos).toHaveLength(1)
    expect(
      readdirSync(join(testState.dir, 'profile-move-intents')).filter((file) =>
        file.endsWith('.json')
      )
    ).toEqual([])
  })

  it('moves between rollback-window profiles while retaining their JSON exports', async () => {
    const sourceState = makeState({ repos: [makeRepo()] })
    writeProfileState('personal', sourceState)
    writeProfileState('work', makeState())
    const sourceJson = readFileSync(profileDataPath('personal'), 'utf-8')
    const targetJson = readFileSync(profileDataPath('work'), 'utf-8')
    writeProfileStateDatabaseWithAcceptedLegacyJson('personal', sourceJson)
    writeProfileStateDatabaseWithAcceptedLegacyJson('work', targetJson)

    const { transferOrcaProfileProject } = await loadTransferModule()
    const result = transferOrcaProfileProject(
      {
        sourceProfileId: 'personal',
        targetProfileId: 'work',
        repoId: 'repo-1',
        mode: 'move'
      },
      testState.dir
    )

    expect(result.status).toBe('transferred')
    expect(readProfileStateDatabase('personal').repos).toHaveLength(0)
    expect(readProfileStateDatabase('work').repos).toHaveLength(1)
    expect(readFileSync(profileDataPath('personal'), 'utf-8')).toBe(sourceJson)
    expect(readFileSync(profileDataPath('work'), 'utf-8')).toBe(targetJson)
  })

  it('migrates a legacy JSON target before moving a SQLite-backed project', async () => {
    const sourceState = makeState({ repos: [makeRepo()] })
    writeProfileStateDatabase('personal', sourceState)
    writeProfileState('work', makeState())

    const { transferOrcaProfileProject } = await loadTransferModule()
    expect(
      transferOrcaProfileProject(
        {
          sourceProfileId: 'personal',
          targetProfileId: 'work',
          repoId: 'repo-1',
          mode: 'move'
        },
        testState.dir
      )
    ).toMatchObject({ status: 'transferred', mode: 'move' })
    expect(readProfileStateDatabase('personal').repos).toHaveLength(0)
    expect(readProfileStateDatabase('work').repos).toHaveLength(1)
    expect(readProfileState('work').repos).toHaveLength(0)
  })

  it.each([undefined, 'prepared', 'target-committed'])(
    'replays a move after the target commit with legacy phase=%s',
    async (phase) => {
      writeProfileStateDatabase('personal', makeState({ repos: [makeRepo()] }))
      writeProfileStateDatabase('work', makeState())
      const stateFile = await import('./profile-project-state-file')
      const source = stateFile.readProfileStateWithRevision('personal', testState.dir)
      const target = stateFile.readProfileStateWithRevision('work', testState.dir)
      const sourceAfter = makeState()
      const targetAfter = makeState({ repos: [makeRepo()] })
      const intent = createProfileProjectMoveIntent({
        sourceProfileId: 'personal',
        targetProfileId: 'work',
        source,
        target,
        sourceAfterJson: JSON.stringify(sourceAfter),
        targetAfterJson: JSON.stringify(targetAfter)
      })
      const historicalIntent = phase === undefined ? intent : { ...intent, phase }
      persistProfileProjectMoveIntent(testState.dir, historicalIntent)
      stateFile.writeProfileState('work', testState.dir, targetAfter, {
        expectedRevision: target.revision
      })

      expect(recoverPendingProfileProjectMoves(testState.dir)).toBe(1)
      expect(recoverPendingProfileProjectMoves(testState.dir)).toBe(0)
      expect(readProfileStateDatabase('personal').repos).toHaveLength(0)
      expect(readProfileStateDatabase('work').repos).toHaveLength(1)
      expect(
        readdirSync(join(testState.dir, 'profile-move-intents')).filter((file) =>
          file.endsWith('.json')
        )
      ).toEqual([])
    }
  )

  it('refuses a move intent whose after-state bytes no longer match their hashes', async () => {
    writeProfileStateDatabase('personal', makeState({ repos: [makeRepo()] }))
    writeProfileStateDatabase('work', makeState())
    const stateFile = await import('./profile-project-state-file')
    const source = stateFile.readProfileStateWithRevision('personal', testState.dir)
    const target = stateFile.readProfileStateWithRevision('work', testState.dir)
    const intent = createProfileProjectMoveIntent({
      sourceProfileId: 'personal',
      targetProfileId: 'work',
      source,
      target,
      sourceAfterJson: JSON.stringify(makeState()),
      targetAfterJson: JSON.stringify(makeState({ repos: [makeRepo()] }))
    })
    persistProfileProjectMoveIntent(testState.dir, intent)
    stateFile.writeProfileState('work', testState.dir, makeState({ repos: [makeRepo()] }), {
      expectedRevision: target.revision
    })
    const intentPath = join(testState.dir, 'profile-move-intents', `${intent.id}.json`)
    const tampered = JSON.parse(readFileSync(intentPath, 'utf8'))
    tampered.sourceAfterJson = JSON.stringify(
      makeState({ settings: { ...makeState().settings, theme: 'light' } })
    )
    writeFileSync(intentPath, JSON.stringify(tampered), 'utf8')

    expect(() => recoverPendingProfileProjectMoves(testState.dir)).toThrow(/intent is malformed/)
    expect(readProfileStateDatabase('personal').repos).toHaveLength(1)
    expect(existsSync(intentPath)).toBe(true)
  })
})
