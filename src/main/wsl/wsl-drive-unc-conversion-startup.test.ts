import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import type { PersistedState } from '../../shared/persisted-state-types'
import { getHistorySessionDirName } from '../daemon/history-paths'
import { readProfileProjectTransferState } from '../orca-profiles/profile-project-domain-state'
import { getOrcaProfileStateDatabaseFile } from '../orca-profiles/profile-storage-paths'
import { openProfileStateDatabase } from '../persistence/profile-state/profile-state-database'
import { importProfileStateJson } from '../persistence/profile-state/profile-state-documents'
import Database from '../sqlite/sync-database'
import { hashWorktreeId } from '../terminal-history-id'
import {
  listWslDriveUncConversions,
  writeWslDriveUncConversion,
  type WslDriveUncConversion
} from './wsl-drive-unc-conversion-journal'
import { runWslDriveUncConversionsAtStartup } from './wsl-drive-unc-conversion-startup'
import {
  wslDriveUncConversionStores,
  type WslDriveUncConversionStore
} from './wsl-drive-unc-conversion-stores'

const PROFILE = 'profile-1'
const UNC = String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\app`
const OLD_ID = `repo-a::${UNC}`
const NEW_ID = String.raw`repo-a::C:\src\app`
const OLD_SESSION = `${OLD_ID}@@s1`

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-drive-unc-startup-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function profileState(): PersistedState {
  const state = getDefaultPersistedState('/home/me')
  state.repos = [{ id: 'repo-a', path: UNC, displayName: 'app', badgeColor: '', addedAt: 0 }]
  state.projects = [
    {
      id: 'repo-a',
      displayName: 'app',
      badgeColor: '',
      sourceRepoIds: ['repo-a'],
      createdAt: 0,
      updatedAt: 0
    }
  ]
  state.worktreeMeta = {
    [OLD_ID]: {
      displayName: 'app',
      comment: 'keep me',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0
    }
  }
  state.workspaceSession.activeWorktreeId = OLD_ID
  state.workspaceSession.tabsByWorktree = {
    [OLD_ID]: [
      {
        id: 'tab-1',
        ptyId: OLD_SESSION,
        worktreeId: OLD_ID,
        title: 'shell',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 0
      }
    ]
  }
  return state
}

function seedProfile(state: PersistedState): void {
  const file = getOrcaProfileStateDatabaseFile(PROFILE, root)
  mkdirSync(join(file, '..'), { recursive: true })
  const opened = openProfileStateDatabase(file, PROFILE)
  try {
    importProfileStateJson(opened.db, JSON.stringify(state))
  } finally {
    opened.db.close()
  }
}

function readProfile(): PersistedState {
  return readProfileProjectTransferState(PROFILE, root).state
}

function journal(overrides: Partial<WslDriveUncConversion> = {}): void {
  writeWslDriveUncConversion(root, {
    version: 1,
    migrationId: 'conv-1',
    distro: 'Ubuntu',
    repoIds: ['repo-a'],
    folderWorkspaceIds: [],
    rootPaths: [UNC],
    phase: 'prepared',
    worktreeIds: [],
    rewrittenStores: [],
    createdAt: '2026-10-24T00:00:00.000Z',
    updatedAt: '2026-10-24T00:00:00.000Z',
    ...overrides
  })
}

function realStores(): WslDriveUncConversionStore[] {
  return wslDriveUncConversionStores({
    daemonHistoryDir: join(root, 'terminal-history'),
    shellHistoryRoots: [join(root, 'terminal-history-wsl', 'Ubuntu')],
    orchestrationDatabasePath: join(root, 'orchestration.db'),
    chatJournalDatabasePath: join(root, 'agent-session-journal.db')
  })
}

function run(stores = realStores()) {
  return runWslDriveUncConversionsAtStartup({
    userDataPath: root,
    profileUserDataPath: root,
    profileId: PROFILE,
    stores
  })
}

function seedOutside(): void {
  const session = join(root, 'terminal-history', getHistorySessionDirName(OLD_SESSION))
  mkdirSync(session, { recursive: true })
  writeFileSync(join(session, 'meta.json'), '{"cwd":"/mnt/c/src/app"}')
  const shell = join(root, 'terminal-history-wsl', 'Ubuntu', hashWorktreeId(OLD_ID))
  mkdirSync(shell, { recursive: true })
  writeFileSync(join(shell, 'meta.json'), JSON.stringify({ worktreeId: OLD_ID }))
  writeFileSync(join(shell, '.bash_history'), 'make test\n')
  const db = new Database(join(root, 'agent-session-journal.db'))
  db.exec(`CREATE TABLE journal_sessions (session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, epoch TEXT NOT NULL);
CREATE TABLE agent_session_records (session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);`)
  db.prepare('INSERT INTO journal_sessions VALUES (?, ?, ?)').run('chat-1', OLD_ID, 'e1')
  db.prepare('INSERT INTO agent_session_records VALUES (?, ?)').run(
    'chat-1',
    JSON.stringify({ id: 'chat-1', location: { workspaceId: OLD_ID, wslDistro: 'Ubuntu' } })
  )
  db.prepare('INSERT INTO agent_session_records VALUES (?, ?)').run('chat-2', '{not json')
  db.close()
}

function chatRows(): unknown[] {
  const db = new Database(join(root, 'agent-session-journal.db'))
  try {
    return [
      ...db.prepare('SELECT workspace_id FROM journal_sessions').all(),
      ...db.prepare('SELECT record_json FROM agent_session_records ORDER BY session_id').all()
    ]
  } finally {
    db.close()
  }
}

describe('runWslDriveUncConversionsAtStartup', () => {
  it('rewrites the profile and every outside store, then drops the journal', () => {
    seedProfile(profileState())
    seedOutside()
    journal()
    const hashes = () =>
      Object.fromEntries(
        (readProfileProjectTransferState(PROFILE, root).documents ?? []).map((document) => [
          document.domain,
          document.contentHash
        ])
      )
    const before = hashes()
    expect(run()).toEqual([
      { migrationId: 'conv-1', outcome: 'converted', repoIds: ['repo-a'], folderWorkspaceIds: [] }
    ])
    // Only the re-keyed fields were written; settings and everything else kept their bytes. The
    // repo's host setup is derived from its row, path included.
    const changed = Object.keys(before).filter((domain) => hashes()[domain] !== before[domain])
    expect(changed.sort()).toEqual([
      'projectHostSetups',
      'projects',
      'repos',
      'workspaceSession',
      'worktreeMeta'
    ])
    const state = readProfile()
    expect(state.repos[0].path).toBe(String.raw`C:\src\app`)
    expect(state.projects[0].localWindowsRuntimePreference).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu',
      git: 'windows-host'
    })
    expect(state.worktreeMeta[NEW_ID]).toMatchObject({
      comment: 'keep me',
      priorWorktreeIds: [OLD_ID]
    })
    expect(state.workspaceSession.tabsByWorktree[NEW_ID]?.[0]?.ptyId).toBe(`${NEW_ID}@@s1`)
    expect(state.workspaceSession.activeWorktreeId).toBe(NEW_ID)
    // The slept pane's session follows its id, so it wakes with its scrollback and folder.
    expect(
      existsSync(join(root, 'terminal-history', getHistorySessionDirName(`${NEW_ID}@@s1`)))
    ).toBe(true)
    expect(existsSync(join(root, 'terminal-history', getHistorySessionDirName(OLD_SESSION)))).toBe(
      false
    )
    const shell = join(root, 'terminal-history-wsl', 'Ubuntu', hashWorktreeId(NEW_ID))
    expect(readFileSync(join(shell, '.bash_history'), 'utf8')).toBe('make test\n')
    expect(JSON.parse(readFileSync(join(shell, 'meta.json'), 'utf8'))).toEqual({
      worktreeId: NEW_ID
    })
    expect(chatRows()).toEqual([
      { workspace_id: NEW_ID },
      {
        record_json: JSON.stringify({
          id: 'chat-1',
          location: { workspaceId: NEW_ID, wslDistro: 'Ubuntu' }
        })
      },
      { record_json: '{not json' }
    ])
    expect(listWslDriveUncConversions(root)).toEqual([])
  })

  it('rolls back, changing nothing, when the profile cannot be re-keyed', () => {
    const state = profileState()
    // The drive id is already taken: converting would merge two worktrees' rows.
    state.worktreeMeta[NEW_ID] = state.worktreeMeta[OLD_ID]
    seedProfile(state)
    seedOutside()
    journal()
    expect(run()).toEqual([
      { migrationId: 'conv-1', outcome: 'rolled-back', detail: 'wsl_drive_unc_key_collision' }
    ])
    expect(readProfile().repos[0].path).toBe(UNC)
    expect(existsSync(join(root, 'terminal-history', getHistorySessionDirName(OLD_SESSION)))).toBe(
      true
    )
    expect(listWslDriveUncConversions(root)).toEqual([])
  })

  it('keeps the profile converted and resumes a failed store at the next startup', () => {
    seedProfile(profileState())
    seedOutside()
    journal()
    let failing = true
    const stores = realStores().map((store) =>
      store.id === 'shell-history'
        ? {
            ...store,
            run: (ids: ReadonlyMap<string, string>) => {
              if (failing) {
                throw new Error('disk busy')
              }
              store.run(ids)
            }
          }
        : store
    )
    expect(run(stores)).toEqual([
      { migrationId: 'conv-1', outcome: 'resuming', store: 'shell-history', detail: 'disk busy' }
    ])
    expect(readProfile().repos[0].path).toBe(String.raw`C:\src\app`)
    expect(listWslDriveUncConversions(root)[0]).toMatchObject({
      phase: 'profile-rewritten',
      rewrittenStores: ['terminal-history'],
      worktreeIds: [[OLD_ID, NEW_ID]]
    })
    failing = false
    expect(run(stores)[0]?.outcome).toBe('converted')
    const shell = join(root, 'terminal-history-wsl', 'Ubuntu', hashWorktreeId(NEW_ID))
    expect(existsSync(shell)).toBe(true)
  })

  it('finishes a conversion that crashed after the profile commit, from the journaled ids', () => {
    seedProfile(profileState())
    seedOutside()
    journal()
    // As if the first run committed the profile and died before advancing the journal.
    run([])
    journal({ worktreeIds: [[OLD_ID, NEW_ID]] })
    const before = readProfile()
    expect(run()[0]?.outcome).toBe('converted')
    expect(readProfile()).toEqual(before)
    expect(
      existsSync(join(root, 'terminal-history', getHistorySessionDirName(`${NEW_ID}@@s1`)))
    ).toBe(true)
    expect(chatRows()[0]).toEqual({ workspace_id: NEW_ID })
  })
})
