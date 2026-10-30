import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { encodeAgentSessionRecord } from '../../shared/agent-session-record-stored-form'
import type { PersistedState } from '../../shared/persisted-state-types'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../shared/wsl-host-internal-gate'
import { getHistorySessionDirName } from '../daemon/history-paths'
import { readProfileProjectTransferState } from '../orca-profiles/profile-project-domain-state'
import { getOrcaProfileStateDatabaseFile } from '../orca-profiles/profile-storage-paths'
import { openProfileStateDatabase } from '../persistence/profile-state/profile-state-database'
import { importProfileStateJson } from '../persistence/profile-state/profile-state-documents'
import Database from '../sqlite/sync-database'
import { loadAgentSessionStoreRows } from '../runtime/agent-session-record-rows'
import { getAgentSessionConversation } from '../runtime/agent-session-store-state'
import { hashWorktreeId } from '../terminal-history-id'
import type * as Journal from './wsl-drive-unc-conversion-journal'
import {
  listWslDriveUncConversions,
  writeWslDriveUncConversion,
  type WslDriveUncConversion
} from './wsl-drive-unc-conversion-journal'
import {
  lastWslDriveUncConversionOutcomes,
  runPendingWslDriveUncConversions,
  runWslDriveUncConversionsAtStartup
} from './wsl-drive-unc-conversion-startup'
import {
  wslDriveUncConversionStores,
  type WslDriveUncConversionStore
} from './wsl-drive-unc-conversion-stores'

const journalWrites = vi.hoisted((): { failPhase: string | null } => ({ failPhase: null }))
vi.mock('./wsl-drive-unc-conversion-journal', async (original) => {
  const actual = await original<typeof Journal>()
  return {
    ...actual,
    writeWslDriveUncConversion: (userDataPath: string, record: WslDriveUncConversion) => {
      if (record.phase === journalWrites.failPhase) {
        throw new Error('journal disk full')
      }
      actual.writeWslDriveUncConversion(userDataPath, record)
    }
  }
})

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
  journalWrites.failPhase = null
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
    profileId: PROFILE,
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

function stoppedChat(workspaceId = OLD_ID) {
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      sessionId: 'chat-alpha-1',
      runtimeFence: 8,
      claimStatus: 'released',
      ownerProcess: null,
      reservedSpawnToken: null,
      deathEvidence: {
        kind: 'kill-delivered',
        detail: 'killed',
        observedAt: 40_000,
        ownerFence: 7,
        lastProvenAliveAt: 30_000,
        runtimeEnd: 'quit'
      }
    })
  )
  return { ...record, location: { ...record.location, workspaceId, wslDistro: 'Ubuntu' } }
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
CREATE TABLE agent_session_records (session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
CREATE TABLE agent_session_operations (operation_key TEXT PRIMARY KEY, row_json TEXT);
CREATE TABLE agent_session_retired_claim_keys (key_id TEXT PRIMARY KEY, retired_at INTEGER);
CREATE TABLE agent_session_tabs (tab_id TEXT PRIMARY KEY, session_id TEXT, position INTEGER);
CREATE TABLE agent_session_store_meta (key TEXT PRIMARY KEY, value TEXT);`)
  db.prepare('INSERT INTO journal_sessions VALUES (?, ?, ?)').run('chat-alpha-1', OLD_ID, 'e1')
  db.prepare('INSERT INTO agent_session_records VALUES (?, ?)').run(
    'chat-alpha-1',
    JSON.stringify(encodeAgentSessionRecord(stoppedChat()))
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
      { record_json: '{not json' },
      {
        record_json: JSON.stringify(encodeAgentSessionRecord(stoppedChat(NEW_ID)))
      }
    ])
    const db = new Database(join(root, 'agent-session-journal.db'))
    try {
      const loaded = loadAgentSessionStoreRows(db)
      expect(loaded.records.get('chat-alpha-1')?.lease.deathEvidence).toEqual(
        stoppedChat().lease.deathEvidence
      )
      expect(getAgentSessionConversation(loaded, 'chat-alpha-1')).toMatchObject({
        location: { workspaceId: NEW_ID, wslDistro: 'Ubuntu' },
        currentFence: 8,
        ownerObservation: {
          claimStatus: 'released',
          deathEvidence: { kind: 'kill-delivered', ownerFence: 7 }
        }
      })
    } finally {
      db.close()
    }
    // The window's stores record themselves once it opens.
    expect(listWslDriveUncConversions(root)).toEqual([
      expect.objectContaining({
        phase: 'profile-rewritten',
        rewrittenStores: [
          'terminal-history',
          'shell-history',
          'orchestration-history',
          'chat-journal'
        ]
      })
    ])
  })

  it('rolls back, changing nothing, when the profile cannot be re-keyed', () => {
    const state = profileState()
    // The drive id already holds different user data: merging would lose one of them.
    state.worktreeMeta[NEW_ID] = { ...state.worktreeMeta[OLD_ID], displayName: 'other' }
    seedProfile(state)
    seedOutside()
    journal()
    expect(run()).toEqual([
      {
        migrationId: 'conv-1',
        outcome: 'rolled-back',
        detail: `wsl_drive_unc_key_collision: ${NEW_ID}`
      }
    ])
    expect(readProfile().repos[0].path).toBe(UNC)
    expect(existsSync(join(root, 'terminal-history', getHistorySessionDirName(OLD_SESSION)))).toBe(
      true
    )
    expect(listWslDriveUncConversions(root)).toEqual([])
  })

  it('converts past a shell history meta.json a crash left torn, keeping its history', () => {
    seedProfile(profileState())
    seedOutside()
    const shell = join(root, 'terminal-history-wsl', 'Ubuntu', hashWorktreeId(OLD_ID))
    writeFileSync(join(shell, 'meta.json'), '{"worktreeId":')
    journal()

    expect(run()[0]?.outcome).toBe('converted')
    const moved = join(root, 'terminal-history-wsl', 'Ubuntu', hashWorktreeId(NEW_ID))
    expect(readFileSync(join(moved, '.bash_history'), 'utf8')).toBe('make test\n')
    // The chats re-key after the history store, so a torn meta.json no longer leaves them behind.
    expect(chatRows()[0]).toEqual({ workspace_id: NEW_ID })
    // Every main-process store finished; the journal waits only for the window's stores.
    expect(listWslDriveUncConversions(root)).toEqual([
      expect.objectContaining({
        phase: 'profile-rewritten',
        rewrittenStores: [
          'terminal-history',
          'shell-history',
          'orchestration-history',
          'chat-journal'
        ]
      })
    ])
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

  it('never reports a committed profile as rolled back when the journal cannot advance', () => {
    seedProfile(profileState())
    seedOutside()
    journal()
    journalWrites.failPhase = 'profile-rewritten'
    expect(run()).toEqual([
      { migrationId: 'conv-1', outcome: 'resuming', store: 'journal', detail: 'journal disk full' }
    ])
    expect(readProfile().repos[0].path).toBe(String.raw`C:\src\app`)
    // Still 'prepared', whose rewrite is idempotent, with the ids journaled before the commit.
    expect(listWslDriveUncConversions(root)).toEqual([
      expect.objectContaining({ phase: 'prepared', worktreeIds: [[OLD_ID, NEW_ID]] })
    ])
    journalWrites.failPhase = null
    expect(run()[0]?.outcome).toBe('converted')
    expect(chatRows()[0]).toEqual({ workspace_id: NEW_ID })
  })

  it("leaves another profile's conversion journaled until that profile starts", () => {
    seedProfile(profileState())
    journal({ profileId: 'profile-2' })
    expect(run()).toEqual([])
    expect(readProfile().repos[0].path).toBe(UNC)
    expect(listWslDriveUncConversions(root)).toHaveLength(1)
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

describe('runPendingWslDriveUncConversions', () => {
  const originalPlatform = process.platform
  afterEach(() => {
    vi.unstubAllEnvs()
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  // Any platform finishes a journaled conversion once the gate is open; only the gate stops it.
  it.each([
    ['on Windows', 'win32', ''],
    ['off Windows', 'linux', '']
  ])(
    'leaves a journaled conversion untouched with the gate closed, %s',
    (_case, platform, gate) => {
      vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, gate)
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      seedProfile(profileState())
      journal()

      runPendingWslDriveUncConversions({
        userDataPath: root,
        profileUserDataPath: root,
        profileId: PROFILE
      })

      expect(lastWslDriveUncConversionOutcomes()).toEqual([])
      expect(listWslDriveUncConversions(root)).toEqual([
        expect.objectContaining({ phase: 'prepared' })
      ])
      expect(readProfile().repos[0].path).toBe(UNC)
    }
  )
})
