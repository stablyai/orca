// @orca-isolated-worker -- This suite owns the startup worker-spawn boundary.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { PersistedState } from '../../../shared/persisted-state-types'
import '../../../shared/wsl-host-internal-gate'
import { getHistorySessionDirName } from '../../daemon/history/storage/history-paths'
import { readProfileProjectTransferState } from '../../orca-profiles/project-transfer/profile-project-domain-state'
import { getOrcaProfileStateDatabaseFile } from '../../orca-profiles/profile-storage-paths'
import { openProfileStateDatabase } from '../../persistence/profile-state/database/profile-state-database'
import { importProfileStateJson } from '../../persistence/profile-state/documents/profile-state-documents'
import Database from '../../sqlite/sync-database'
import * as workerSpawning from '../../worker-threads/worker-thread-spawn'
import { openJournalDomainDatabase } from '../../native-chat/agent-session-journal/database/journal-domain-database'
import { openJournalDatabase } from '../../native-chat/agent-session-journal/database/journal-database'
import { journalSqlWorkerPath } from '../../native-chat/agent-session-journal/journal-sql-worker-bundle.test-fixture'
import { hashWorktreeId } from '../../pty/history/terminal-history-id'
import type * as Journal from './wsl-drive-unc-conversion-journal'
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

const SAVED_STOPPED_CHAT = {
  schemaVersion: 2,
  sessionId: 'chat-alpha-1',
  location: {
    executionHostId: 'local',
    wslDistro: 'Ubuntu',
    workspaceId: OLD_ID,
    workspaceKind: 'git-worktree'
  },
  provider: 'claude',
  providerHandleChain: [
    {
      linkId: 'link-1',
      origin: 'created',
      mintedAtFence: 8,
      observedAt: 1000,
      handle: { provider: 'claude', sessionId: 'provider-session-alpha-1', leafUuid: null }
    }
  ],
  accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/user/.claude' },
  lease: {
    sessionId: 'chat-alpha-1',
    runtimeKind: 'native',
    runtimeFence: 8,
    handoffStage: null,
    provenHandleLinkId: 'link-1',
    ownerProcess: null,
    reservedSpawnToken: null,
    leaseDeadlineAt: 60000,
    lastRenewedAt: 30000,
    handoffOperationId: null,
    claimKeyId: 'key-1',
    claimStatus: 'released',
    unreconciled: false,
    deathEvidence: {
      kind: 'pid-absent',
      detail: 'killed',
      observedAt: 40000,
      ownerFence: 7,
      lastProvenAliveAt: 30000,
      runtimeEnd: 'quit',
      delivery: 'kill'
    }
  },
  createdAt: 1000,
  updatedAt: 2000
}
const REKEYED_STOPPED_CHAT = JSON.stringify({
  ...SAVED_STOPPED_CHAT,
  location: {
    executionHostId: 'local',
    wslDistro: 'Ubuntu',
    workspaceId: String.raw`repo-a::C:\src\app`,
    workspaceKind: 'git-worktree'
  }
})

let root: string
const spawnWorker = workerSpawning.spawnWorkerThread

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-drive-unc-startup-'))
  vi.spyOn(workerSpawning, 'spawnWorkerThread').mockImplementation((_filename, options) =>
    spawnWorker(journalSqlWorkerPath(), options)
  )
})

afterEach(() => {
  journalWrites.failPhase = null
  vi.restoreAllMocks()
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
    chatJournalDatabasePath: join(root, 'agent-session-domain.db')
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
  const { db } = openJournalDomainDatabase(join(root, 'agent-session-domain.db'))
  seedChats(db)
  db.close()
}

function seedChats(db: Database.Database, legacy = false): void {
  if (legacy) {
    db.prepare('INSERT INTO journal_sessions VALUES (?, ?, ?)').run('chat-alpha-1', OLD_ID, 'e1')
  } else {
    db.prepare(
      'INSERT INTO journal_chat_state(session_id, workspace_id, epoch) VALUES (?, ?, ?)'
    ).run('chat-alpha-1', OLD_ID, 'e1')
  }
  db.prepare('INSERT INTO agent_session_records VALUES (?, ?)').run(
    'chat-alpha-1',
    JSON.stringify(SAVED_STOPPED_CHAT)
  )
  db.prepare('INSERT INTO agent_session_records VALUES (?, ?)').run('chat-2', '{not json')
}

function chatRows(): unknown[] {
  const db = new Database(join(root, 'agent-session-domain.db'))
  try {
    return [
      ...db.prepare('SELECT workspace_id FROM journal_chat_state').all(),
      ...db.prepare('SELECT record_json FROM agent_session_records ORDER BY session_id').all()
    ]
  } finally {
    db.close()
  }
}

describe('runWslDriveUncConversionsAtStartup', () => {
  it('rolls back, changing nothing, when the profile cannot be re-keyed', async () => {
    const state = profileState()
    // The drive id already holds different user data: merging would lose one of them.
    state.worktreeMeta[NEW_ID] = { ...state.worktreeMeta[OLD_ID], displayName: 'other' }
    seedProfile(state)
    seedOutside()
    journal()
    expect(await run()).toEqual([
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

  it('keeps the profile converted and resumes a failed store at the next startup', async () => {
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
              return store.run(ids)
            }
          }
        : store
    )
    expect(await run(stores)).toEqual([
      { migrationId: 'conv-1', outcome: 'resuming', store: 'shell-history', detail: 'disk busy' }
    ])
    expect(readProfile().repos[0].path).toBe(String.raw`C:\src\app`)
    expect(listWslDriveUncConversions(root)[0]).toMatchObject({
      phase: 'profile-rewritten',
      rewrittenStores: ['terminal-history'],
      worktreeIds: [[OLD_ID, NEW_ID]]
    })
    failing = false
    expect((await run(stores))[0]?.outcome).toBe('converted')
    const shell = join(root, 'terminal-history-wsl', 'Ubuntu', hashWorktreeId(NEW_ID))
    expect(existsSync(shell)).toBe(true)
  })

  it('never reports a committed profile as rolled back when the journal cannot advance', async () => {
    seedProfile(profileState())
    seedOutside()
    journal()
    journalWrites.failPhase = 'profile-rewritten'
    expect(await run()).toEqual([
      { migrationId: 'conv-1', outcome: 'resuming', store: 'journal', detail: 'journal disk full' }
    ])
    expect(readProfile().repos[0].path).toBe(String.raw`C:\src\app`)
    // Still 'prepared', whose rewrite is idempotent, with the ids journaled before the commit.
    expect(listWslDriveUncConversions(root)).toEqual([
      expect.objectContaining({ phase: 'prepared', worktreeIds: [[OLD_ID, NEW_ID]] })
    ])
    journalWrites.failPhase = null
    expect((await run())[0]?.outcome).toBe('converted')
    expect(chatRows()[0]).toEqual({ workspace_id: NEW_ID })
  })

  it("leaves another profile's conversion journaled until that profile starts", async () => {
    seedProfile(profileState())
    journal({ profileId: 'profile-2' })
    expect(await run()).toEqual([])
    expect(readProfile().repos[0].path).toBe(UNC)
    expect(listWslDriveUncConversions(root)).toHaveLength(1)
  })

  it('imports legacy metadata before rekeying an absent domain and preserves the original', async () => {
    seedProfile(profileState())
    const original = join(root, 'agent-session-journal.db')
    const { db } = openJournalDatabase(original)
    seedChats(db, true)
    db.close()
    const before = readFileSync(original)
    journal()

    expect((await run())[0]?.outcome).toBe('converted')
    expect(chatRows()).toEqual([
      { workspace_id: NEW_ID },
      { record_json: '{not json' },
      { record_json: REKEYED_STOPPED_CHAT }
    ])
    expect(readFileSync(original)).toEqual(before)
    // Retry through a later physical owner sees the same identities, without reimporting.
    journal({ phase: 'profile-rewritten', worktreeIds: [[OLD_ID, NEW_ID]] })
    expect((await run())[0]?.outcome).toBe('converted')
    expect(chatRows()[0]).toEqual({ workspace_id: NEW_ID })
  })

  it('rolls back both chat identities on failed rekey and completes them on retry', async () => {
    seedProfile(profileState())
    seedOutside()
    const before = chatRows()
    const db = new Database(join(root, 'agent-session-domain.db'))
    db.exec(`CREATE TRIGGER refuse_rekey BEFORE UPDATE ON agent_session_records
      BEGIN SELECT RAISE(ABORT, 'rekey refused'); END`)
    db.close()
    journal()

    expect(await run()).toEqual([
      { migrationId: 'conv-1', outcome: 'resuming', store: 'chat-journal', detail: 'rekey refused' }
    ])
    expect(chatRows()).toEqual(before)
    expect(readProfile().repos[0].path).toBe(String.raw`C:\src\app`)
    expect(listWslDriveUncConversions(root)[0]?.rewrittenStores).toEqual([
      'terminal-history',
      'shell-history',
      'orchestration-history'
    ])
    const retry = new Database(join(root, 'agent-session-domain.db'))
    retry.exec('DROP TRIGGER refuse_rekey')
    retry.close()
    expect((await run())[0]?.outcome).toBe('converted')
    expect(chatRows()).toEqual([
      { workspace_id: NEW_ID },
      { record_json: '{not json' },
      { record_json: REKEYED_STOPPED_CHAT }
    ])
  })

  it('leaves the chat ledger pending when a newer domain schema is read-only', async () => {
    seedProfile(profileState())
    seedOutside()
    const before = chatRows()
    const db = new Database(join(root, 'agent-session-domain.db'))
    db.pragma('user_version=100')
    db.close()
    journal()

    expect(await run()).toEqual([
      {
        migrationId: 'conv-1',
        outcome: 'resuming',
        store: 'chat-journal',
        detail: 'chat workspace conversion requires a writable journal'
      }
    ])
    expect(chatRows()).toEqual(before)
    expect(readProfile().repos[0].path).toBe(String.raw`C:\src\app`)
    expect(listWslDriveUncConversions(root)[0]?.rewrittenStores).toEqual([
      'terminal-history',
      'shell-history',
      'orchestration-history'
    ])
  })

  it('waits for observed worker exit after a failed close before returning to startup', async () => {
    seedProfile(profileState())
    journal()
    const worker = new Worker(
      `
      const { parentPort } = require('node:worker_threads');
      parentPort.on('message', request => {
        if (request === 'probe') { parentPort.postMessage('alive'); return; }
        parentPort.postMessage(request.command.type === 'close'
          ? { type: 'failed', id: request.id, outcome: 'not-dispatched',
              error: { name: 'Error', message: 'checkpoint close failed' } }
          : { type: 'maintenance', id: request.id, result: true });
      });
      parentPort.postMessage({ type: 'ready', readOnly: false });
    `,
      { eval: true }
    )
    const terminate = worker.terminate.bind(worker)
    const terminating = Promise.withResolvers<void>()
    const terminated = Promise.withResolvers<number>()
    vi.spyOn(workerSpawning, 'spawnWorkerThread').mockReturnValue(worker)
    vi.spyOn(worker, 'terminate').mockImplementation(() => {
      terminating.resolve()
      return terminated.promise
    })
    const events: string[] = []
    worker.once('exit', () => events.push('exit'))
    const outcome = run().then((result) => {
      events.push('startup-returned')
      return result
    })
    try {
      await terminating.promise
      terminated.resolve(0)
      const alive = once(worker, 'message')
      worker.postMessage('probe')
      expect((await alive)[0]).toBe('alive')
      expect(events).toEqual([])
      expect(listWslDriveUncConversions(root)[0]?.rewrittenStores).toEqual([
        'terminal-history',
        'shell-history',
        'orchestration-history'
      ])
      await terminate()
      expect(await outcome).toEqual([
        {
          migrationId: 'conv-1',
          outcome: 'resuming',
          store: 'chat-journal',
          detail: 'checkpoint close failed'
        }
      ])
      expect(events).toEqual(['exit', 'startup-returned'])
      expect(listWslDriveUncConversions(root)[0]?.rewrittenStores).toEqual([
        'terminal-history',
        'shell-history',
        'orchestration-history'
      ])
    } finally {
      terminated.resolve(0)
      await terminate()
      await outcome
    }
  })

  it('completes an empty identity mapping without initializing a chat database', async () => {
    seedProfile(profileState())
    journal({ phase: 'profile-rewritten' })
    expect((await run())[0]?.outcome).toBe('converted')
    expect(existsSync(join(root, 'agent-session-domain.db'))).toBe(false)
    expect(listWslDriveUncConversions(root)[0]?.rewrittenStores).toEqual([
      'terminal-history',
      'shell-history',
      'orchestration-history',
      'chat-journal'
    ])
  })
})
