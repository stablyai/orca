import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import {
  ORCA_PROFILE_INDEX_SCHEMA_VERSION,
  type OrcaProfileIndex
} from '../../../shared/orca-profiles'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import type { ScheduledMessage } from '../../../shared/scheduled-message-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import {
  exportProfileStateJson,
  importProfileStateJson
} from '../../persistence/profile-state/documents/profile-state-documents'
import { hashProfileStatePayload as hashProfileStateJson } from '../../persistence/profile-state/documents/profile-state-document-validation'
import { openProfileStateDatabase } from '../../persistence/profile-state/database/profile-state-database'
import {
  persistProfileProjectMoveIntent,
  recoverPendingProfileProjectMoves
} from './profile-project-move-intent'
import type { ProfileProjectMoveIntent } from './profile-project-move-record'
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
  return import('./profile-project-transfer')
}

function transferMove(
  transfer: Awaited<ReturnType<typeof loadTransferModule>>['transferOrcaProfileProject']
) {
  return transfer(
    { sourceProfileId: 'personal', targetProfileId: 'work', repoId: 'repo-1', mode: 'move' },
    testState.dir
  )
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

function profileDatabasePath(profileId: string): string {
  return join(testState.dir, 'profiles', profileId, 'profile-state.db')
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

function readProfileStateDatabase(profileId: string): PersistedState {
  const opened = openProfileStateDatabase(profileDatabasePath(profileId), profileId)
  try {
    return JSON.parse(exportProfileStateJson(opened.db))
  } finally {
    opened.db.close()
  }
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

// A profile saved before artifactSharingEnabled existed carries no defaults for it.
function writeOlderProfileStateDatabase(
  profileId: string,
  settings: Record<string, unknown>,
  repos: Repo[] = []
): void {
  const databasePath = profileDatabasePath(profileId)
  mkdirSync(join(databasePath, '..'), { recursive: true })
  const opened = openProfileStateDatabase(databasePath, profileId)
  try {
    importProfileStateJson(opened.db, JSON.stringify({ settings, repos }))
  } finally {
    opened.db.close()
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

  it('drops the moved project’s scheduled messages from the source profile', async () => {
    const movedWorktreeId = 'repo-1::/workspace/orca-feature'
    const stayingWorktreeId = 'repo-2::/workspace/other-feature'
    const message = (worktreeId: string, id: string): ScheduledMessage => ({
      id,
      worktreeId,
      text: 'ping',
      timing: { kind: 'when-idle' },
      createdAt: 1,
      status: 'pending'
    })
    writeProfileStateDatabase(
      'personal',
      makeState({
        repos: [makeRepo(), makeRepo({ id: 'repo-2', path: '/workspace/other' })],
        worktreeMeta: {
          [movedWorktreeId]: makeWorktreeMeta(),
          [stayingWorktreeId]: makeWorktreeMeta()
        },
        scheduledMessages: [
          message(movedWorktreeId, 'msg-moved'),
          message(stayingWorktreeId, 'msg-staying')
        ]
      })
    )
    writeProfileStateDatabase('work', makeState())

    const { transferOrcaProfileProject } = await loadTransferModule()
    transferOrcaProfileProject(
      { sourceProfileId: 'personal', targetProfileId: 'work', repoId: 'repo-1', mode: 'move' },
      testState.dir
    )

    const source = readProfileStateDatabase('personal')
    expect(source.scheduledMessages?.map((entry) => entry.id)).toEqual(['msg-staying'])
    // A move does not carry them: the row is addressed to a pane in the profile it was queued in.
    expect(readProfileStateDatabase('work').scheduledMessages ?? []).toEqual([])
  })

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

  it('moves a project without granting publishing permission to either older profile', async () => {
    writeOlderProfileStateDatabase('personal', {}, [makeRepo()])
    writeOlderProfileStateDatabase('work', {})
    const { transferOrcaProfileProject } = await loadTransferModule()

    expect(transferMove(transferOrcaProfileProject)).toMatchObject({ status: 'transferred' })
    expect(readProfileStateDatabase('personal').settings).not.toHaveProperty(
      'artifactSharingEnabled'
    )
    expect(readProfileStateDatabase('work').settings).not.toHaveProperty('artifactSharingEnabled')
  })
})
