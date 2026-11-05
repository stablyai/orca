import { executeSurfaceOwnerCommand } from './surface-owner-command'
import { readProfileStateRevision } from '../persistence/profile-state/profile-state-documents'
import { mintAgentSessionOperationId } from '../runtime/orchestration/structured-pointer-operation-id'
import { attachSurfaceEvidenceReader } from './surface-cold-evidence'
import { readSurfaceMappings } from './surface-migration-identities'
import { WorkspaceSurfaceRepository } from './surface-repository'
import { seedTestAgentSessionRecordStore } from '../runtime/agent-session/records/agent-session-record-store-test-harness'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { randomUUID } from 'node:crypto'
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import {
  type JournalHostDatabase,
  journalDatabasePath
} from '../native-chat/agent-session-journal/journal-host-database'

import { AgentSessionRecordStore } from '../runtime/agent-session/records/agent-session-record-store'
import { ProfileStateSqliteAuthority } from '../persistence/profile-state/profile-state-sqlite-authority'
import { readSurfaceProfileDomain } from './surface-profile-storage'
import { openWritableProfileStateDatabase } from '../persistence/profile-state/profile-state-database'
import type { SurfaceStorageMutation } from '../../shared/workspace-surfaces/surface-storage-command'
import { ProfileStateWriteWorkerClient } from '../persistence/profile-state/profile-state-writer-worker-client'
import { profileStateWriterFailureOutcome } from '../persistence/profile-state/profile-state-writer-errors'
import { JOURNAL_DB_SCHEMA_VERSION } from '../native-chat/agent-session-journal/journal-database-schema'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { JournalNativeStorage } from '../native-chat/agent-session-journal/journal-native-storage'

let directory: string
let authority: ProfileStateSqliteAuthority
let databasePath: string
const journals: JournalHostDatabase[] = []
const sessionId = 'chat-00000001'
const workspaceId = 'folder::/workspace'
let bundleRoot: string
let worker: ProfileStateWriteWorkerClient | undefined

beforeAll(async () => {
  bundleRoot = mkdtempSync(join(tmpdir(), 'orca-joint-writer-bundle-'))
  await build({
    entryPoints: [
      resolve('src/main/persistence/profile-state/profile-state-writer-worker-entry.ts')
    ],
    outfile: join(bundleRoot, 'profile-state-writer-worker-entry.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
})
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }))

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-surface-joint-'))
  databasePath = join(directory, 'profile-state.db')
  authority = new ProfileStateSqliteAuthority(databasePath, 'joint-test')
  authority.readInitialState()
  authority.executeSurfaceCommand({ type: 'initialize', hostId: 'local' })
})
afterEach(async () => {
  await worker?.close()
  worker = undefined
  await Promise.all(journals.splice(0).map((journal) => journal.close()))
  authority.close()
  rmSync(directory, { recursive: true, force: true })
})

it('does not create a missing journal or mutate a future journal when joint admission is refused', () => {
  const journalPath = journalDatabasePath(directory)
  const before = readHost()
  expect(() => joint()).toThrow()
  expect(existsSync(journalPath)).toBe(false)
  const future = new Database(journalPath)
  future.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION + 1}`)
  future.close()
  const bytes = readFileSync(journalPath)
  expect(() => joint()).toThrow('cannot accept surface membership')
  expect(readFileSync(journalPath)).toEqual(bytes)
  expect(readHost()).toEqual(before)
})

it('rejects a hard-link alias of the profile database before attaching it as a journal', () => {
  const journalPath = journalDatabasePath(directory)
  linkSync(databasePath, journalPath)
  expect(() => joint()).toThrow('separate native journal')
})

async function oldIndex(visible: boolean, tabId = 'chat-tab'): Promise<void> {
  const journal = await openTestJournalHostDatabase(directory)
  journals.push(journal)
  const store = await AgentSessionRecordStore.open({
    journalDatabase: journal,
    hostId: 'local',
    legacySessionTabIds: []
  })
  if (!store.getRecord(sessionId)) {
    await store.reserveOwner({
      sessionId,
      location: { executionHostId: 'local', wslDistro: null, workspaceId, workspaceKind: 'folder' },
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/disposable/codex' },
      expectedFence: null,
      spawnToken: 'spawn',
      claimKeyId: 'key',
      handoffOperationId: null,
      probe: { outcome: 'reservation-unused' },
      operation: {
        callerKey: 'test',
        operationId: mintAgentSessionOperationId(1_700_000_000_000),
        fingerprint: 'found'
      },
      now: 1_700_000_000_000
    })
  }
  await store.setSessionTabVisibility(sessionId, visible, tabId)
  await journal.close()
}

function joint(
  commands: readonly SurfaceStorageMutation[] = [{ hostId: 'local', type: 'initialize' }]
) {
  return authority.executeSurfaceJointTransaction({
    journalPath: journalDatabasePath(directory),
    commands
  })
}

async function openProfileWriter(
  workerPath = join(bundleRoot, 'profile-state-writer-worker-entry.js')
): Promise<ProfileStateWriteWorkerClient> {
  authority.close()
  const bootstrap = new ProfileStateSqliteAuthority(databasePath, 'joint-test')
  bootstrap.readInitialState()
  const opened = new ProfileStateWriteWorkerClient(bootstrap.retireForWorker(), { workerPath })
  worker = opened
  await opened.ready
  return opened
}

function readHost() {
  const db = openWritableProfileStateDatabase(databasePath, 'joint-test').db
  try {
    return readSurfaceProfileDomain(db).hosts.local!
  } finally {
    db.close()
  }
}

function closeRequest(commandId: string): SurfaceStorageMutation {
  const surface = readHost().surfaces.find((row) => row.content?.kind === 'agent-session')!
  return {
    type: 'replace',
    hostId: 'local',
    request: {
      hostId: 'local',
      workspaceId,
      hostTabId: surface.hostTabId,
      expected: { occurrence: surface.occurrence, revision: surface.revision },
      content: null,
      callerId: 'window',
      commandId,
      // ast-grep-ignore: test-no-wall-clock -- The real storage owner validates this bounded deadline against its own clock.
      expiresAt: Date.now() + 60_000
    }
  }
}

it('imports and co-writes actual native membership with matching attribution, then observes an old hide without a profile edit', async () => {
  await oldIndex(true)
  const [imported] = joint()
  expect(imported.host.chatInitialization).toBe('verified')
  expect(imported.host.surfaces).toContainEqual(
    expect.objectContaining({
      hostTabId: 'chat-tab',
      content: { kind: 'agent-session', sessionId, agent: 'codex' }
    })
  )
  const before = readHost().chatBaseline!
  await oldIndex(false)
  expect(readHost().chatBaseline).toEqual(before)
  const [hidden] = joint()
  expect(hidden.host.surfaces.filter((row) => row.content?.kind === 'agent-session')).toEqual([])
  const journal = await openTestJournalHostDatabase(directory)
  journals.push(journal)
  expect(
    await journal.read((read) => read.prepare('SELECT * FROM agent_session_tabs').all())
  ).toEqual([])
  expect(
    await journal.read((read) =>
      read
        .prepare('SELECT record_json FROM agent_session_records WHERE session_id = ?')
        .get(sessionId)
    )
  ).toBeDefined()
  const marker = await journal.read((read) =>
    read
      .prepare('SELECT value FROM agent_session_store_meta WHERE key = ?')
      .get('workspace_surface_projection:local')
  )
  expect(JSON.parse(String(marker?.value))).toEqual(readHost().chatBaseline)
})

it('rolls back canonical retirement, receipt, profile output and native index together when native publication fails', async () => {
  await oldIndex(true)
  joint()
  const before = readHost()
  const close = closeRequest('close-rejected')
  const journal = await openTestJournalHostDatabase(directory)
  journals.push(journal)
  await journal.close()
  const fixture = new Database(journalDatabasePath(directory))
  fixture.exec(
    "CREATE TRIGGER reject_native_close BEFORE DELETE ON agent_session_tabs BEGIN SELECT RAISE(ABORT, 'reject native close'); END"
  )
  fixture.close()
  expect(() => joint([close])).toThrow('reject native close')
  expect(readHost()).toEqual(before)
  const reopened = await openTestJournalHostDatabase(directory)
  journals.push(reopened)
  expect(
    await reopened.read((read) => read.prepare('SELECT session_id FROM agent_session_tabs').all())
  ).toEqual([{ session_id: sessionId }])
  expect(
    await reopened.read((read) =>
      read
        .prepare('SELECT record_json FROM agent_session_records WHERE session_id = ?')
        .get(sessionId)
    )
  ).toBeDefined()
  await reopened.close()
  const repaired = new Database(journalDatabasePath(directory))
  repaired.exec('DROP TRIGGER reject_native_close')
  repaired.close()
  const [closed] = joint([close])
  expect(closed.outcome).toMatchObject({ status: 'accepted' })
  expect(readHost().surfaces.find((row) => row.hostTabId === 'chat-tab')).toBeUndefined()
})

it('preserves a live terminal when an older native index creates a colliding visible tab identity', async () => {
  const leafId = randomUUID()
  const command: SurfaceStorageMutation = {
    type: 'layout',
    hostId: 'local',
    session: authority.executeSurfaceCommand({ type: 'query', hostId: 'local' }).session,
    facts: { startingLeafIds: [], bindings: [] },
    request: {
      hostId: 'local',
      callerId: 'window',
      commandId: 'terminal',
      // ast-grep-ignore: test-no-wall-clock -- The real storage owner validates this bounded deadline against its own clock.
      expiresAt: Date.now() + 60_000,
      targets: [{ workspaceId, hostTabId: 'chat-tab', expected: null }],
      command: { type: 'createTerminalTab', workspace: workspaceId, tabId: 'chat-tab', leafId }
    }
  }
  authority.executeSurfaceCommand(command)
  const terminal = readHost().surfaces.find((row) => row.content?.kind === 'terminal')!
  await oldIndex(true)
  joint()
  const host = readHost()
  expect(host.surfaces).toContainEqual(terminal)
  const chat = host.surfaces.find((row) => row.content?.kind === 'agent-session')!
  expect(chat.hostTabId).not.toBe(terminal.hostTabId)
  expect(chat.content).toEqual({ kind: 'agent-session', sessionId, agent: 'codex' })
  const profile = openWritableProfileStateDatabase(databasePath, 'joint-test')
  let mappings
  try {
    attachSurfaceEvidenceReader(profile.db, 'local', host)
    mappings = readSurfaceMappings(host, workspaceId, 'host-tab', 'chat-tab')
  } finally {
    profile.db.close()
  }
  expect(host.identityMappings).toEqual([])
  expect(mappings).toContainEqual({
    workspaceId,
    kind: 'host-tab',
    previousId: 'chat-tab',
    currentId: chat.hostTabId
  })
})

it('retains unreadable native references through healthy actions and respects their local presentation dismissal', async () => {
  await oldIndex(true)
  const unknown = { tabId: 'unreadable-tab', sessionId: 'unreadable-session' }
  const fixture = new Database(journalDatabasePath(directory))
  fixture
    .prepare('INSERT INTO agent_session_records(session_id, record_json) VALUES (?, ?)')
    .run(unknown.sessionId, '{invalid')
  fixture
    .prepare('INSERT INTO agent_session_tabs(tab_id, session_id, position) VALUES (?, ?, ?)')
    .run(unknown.tabId, unknown.sessionId, 1)
  fixture.close()
  const session = getDefaultWorkspaceSession()
  session.unifiedTabs = {
    [workspaceId]: [
      {
        id: unknown.tabId,
        entityId: unknown.sessionId,
        worktreeId: workspaceId,
        groupId: 'group',
        contentType: 'agent-session',
        label: 'Unavailable chat',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]
  }
  authority.writeSerializedDomains([
    { domain: 'workspaceSession', payload: JSON.stringify(session) }
  ])
  const [imported] = joint()
  expect(imported.session.unifiedTabs?.[workspaceId]?.map((tab) => tab.entityId)).toContain(
    unknown.sessionId
  )
  expect(imported.host.nativeTabs).toContainEqual(unknown)
  const [closed] = joint([closeRequest('healthy-close-beside-unreadable')])
  expect(closed.outcome).toMatchObject({ status: 'accepted' })
  expect(closed.host.nativeTabs).toEqual([unknown])
  expect(closed.session.unifiedTabs?.[workspaceId]?.map((tab) => tab.entityId)).toEqual([
    unknown.sessionId
  ])
  const dismissed = structuredClone(closed.session)
  dismissed.unifiedTabs = {}
  authority.writeSerializedDomains([
    { domain: 'workspaceSession', payload: JSON.stringify(dismissed) }
  ])
  expect(joint()[0].session.unifiedTabs?.[workspaceId] ?? []).toEqual([])
  const saved = new Database(journalDatabasePath(directory))
  try {
    expect(saved.prepare('SELECT tab_id, session_id FROM agent_session_tabs').all()).toEqual([
      { tab_id: unknown.tabId, session_id: unknown.sessionId }
    ])
    expect(
      saved
        .prepare('SELECT record_json FROM agent_session_records WHERE session_id = ?')
        .get(unknown.sessionId)?.record_json
    ).toBe('{invalid')
  } finally {
    saved.close()
  }
})

it('commits native membership through the typed profile worker and preserves it after reopening', async () => {
  await oldIndex(true)
  const writer = await openProfileWriter()
  const [committed] = await writer.executeSurfaceJointTransaction({
    journalPath: journalDatabasePath(directory),
    commands: [{ type: 'initialize', hostId: 'local' }]
  })
  expect(committed.host.surfaces).toContainEqual(
    expect.objectContaining({ content: { kind: 'agent-session', sessionId, agent: 'codex' } })
  )
  await writer.close()
  worker = undefined
  const reopened = new ProfileStateSqliteAuthority(databasePath, 'joint-test')
  try {
    reopened.readInitialState()
    expect(reopened.executeSurfaceCommand({ type: 'query', hostId: 'local' }).host).toEqual(
      committed.host
    )
  } finally {
    reopened.close()
  }
})

it('writes one native projection for a joint local chat close and SSH terminal create', async () => {
  await oldIndex(true)
  joint()
  authority.executeSurfaceCommand({ type: 'initialize', hostId: 'ssh:remote' })
  const remote: SurfaceStorageMutation = {
    type: 'layout',
    hostId: 'ssh:remote',
    session: authority.executeSurfaceCommand({ type: 'query', hostId: 'ssh:remote' }).session,
    facts: { startingLeafIds: [], bindings: [] },
    request: {
      hostId: 'ssh:remote',
      callerId: 'mixed-owner',
      commandId: 'remote-terminal',
      // ast-grep-ignore: test-no-wall-clock -- The real storage owner validates this bounded deadline against its own clock.
      expiresAt: Date.now() + 60_000,
      targets: [{ workspaceId, hostTabId: 'ssh-terminal', expected: null }],
      command: {
        type: 'createTerminalTab',
        workspace: workspaceId,
        tabId: 'ssh-terminal',
        leafId: randomUUID()
      }
    }
  }
  const close = closeRequest('mixed-owner-close')
  const writer = await openProfileWriter()
  const results = await writer.executeSurfaceJointTransaction({
    journalPath: journalDatabasePath(directory),
    commands: [close, remote]
  })
  expect(results.map((result) => result.outcome)).toEqual([
    expect.objectContaining({ status: 'accepted' }),
    expect.objectContaining({ status: 'accepted' })
  ])
  expect(results.map((result) => result.host.nativeTabs)).toEqual([[], []])
  const journal = new Database(journalDatabasePath(directory), { readonly: true })
  try {
    expect(journal.prepare('SELECT * FROM agent_session_tabs').all()).toEqual([])
    expect(
      journal
        .prepare('SELECT session_id FROM agent_session_records WHERE session_id = ?')
        .get(sessionId)
    ).toBeDefined()
  } finally {
    journal.close()
  }
  await writer.close()
  worker = undefined
  const reopened = new ProfileStateSqliteAuthority(databasePath, 'joint-test')
  try {
    reopened.readInitialState()
    expect(
      reopened
        .executeSurfaceCommand({ type: 'query', hostId: 'local' })
        .host.surfaces.find((row) => row.hostTabId === 'chat-tab')
    ).toBeUndefined()
    expect(
      reopened.executeSurfaceCommand({ type: 'query', hostId: 'ssh:remote' }).host.surfaces
    ).toContainEqual(
      expect.objectContaining({
        hostTabId: 'ssh-terminal',
        content: expect.objectContaining({ kind: 'terminal' })
      })
    )
  } finally {
    reopened.close()
  }
})

it('streams native effects into the common commit and rolls them back with a rejected native index', async () => {
  await oldIndex(true)
  joint()
  const before = readHost()
  const command = closeRequest('joint-unit-close')
  const writer = await openProfileWriter()
  const fixture = new Database(journalDatabasePath(directory))
  fixture.exec(
    "CREATE TRIGGER reject_joint_unit BEFORE DELETE ON agent_session_tabs BEGIN SELECT RAISE(ABORT, 'reject joint unit'); END"
  )
  fixture.close()
  const rows = Array.from({ length: 160 }, (_, index) => ({
    epoch: 'joint-unit',
    seq: index + 1,
    savedAt: 1_700_000_000_000,
    json: JSON.stringify({ text: 'x'.repeat(2048), index })
  }))
  const transaction = { journalPath: journalDatabasePath(directory), commands: [command] }
  const effects = [{ kind: 'rows' as const, sessionId, rows }]
  await expect(writer.executeSurfaceJournalUnit(transaction, effects)).rejects.toThrow(
    'reject joint unit'
  )
  expect(readHost()).toEqual(before)
  const rejected = new Database(journalDatabasePath(directory))
  expect(
    rejected.prepare('SELECT COUNT(*) AS n FROM journal_rows WHERE epoch = ?').get('joint-unit')?.n
  ).toBe(0)
  rejected.exec('DROP TRIGGER reject_joint_unit')
  rejected.close()
  const committed = await writer.executeSurfaceJournalUnit(transaction, effects)
  expect(committed.values).toEqual([null])
  expect(committed.surfaces[0].outcome).toMatchObject({ status: 'accepted' })
  const saved = new Database(journalDatabasePath(directory))
  try {
    expect(
      saved.prepare('SELECT COUNT(*) AS n FROM journal_rows WHERE epoch = ?').get('joint-unit')?.n
    ).toBe(rows.length)
    expect(saved.prepare('SELECT * FROM agent_session_tabs').all()).toEqual([])
  } finally {
    saved.close()
  }
})

it.each([false, true])(
  'drains a WAL reader for atomic membership and preserves the commit after reopen failure=%s',
  async (failReopen) => {
    await oldIndex(true)
    joint()
    const command = closeRequest('wal-reader-close')
    const writer = await openProfileWriter()
    const journal = await openTestJournalHostDatabase(directory)
    journals.push(journal)
    const lease = await journal.snapshot(() => undefined)
    if (failReopen) {
      vi.spyOn(JournalNativeStorage.prototype, 'reopen').mockRejectedValueOnce(
        new Error('WAL reopen failed')
      )
    }
    let adopted = false
    const committed = journal.joint(
      (journalPath) => writer.executeSurfaceJournalUnit({ journalPath, commands: [command] }, []),
      () => {
        adopted = true
      }
    )
    const next = journal.read((read) => read.prepare('SELECT * FROM agent_session_tabs').all())
    // The existing snapshot still reads the old membership while the admitted drain owns the next write.
    try {
      expect(await lease.read.prepare('SELECT session_id FROM agent_session_tabs').all()).toEqual([
        { session_id: sessionId }
      ])
    } finally {
      await lease.close()
    }
    if (failReopen) {
      await expect(committed).rejects.toMatchObject({ outcome: 'committed' })
      await expect(next).rejects.toThrow()
      expect(journal.isFaulted).toBe(true)
    } else {
      const result = await committed
      expect(result.surfaces[0].outcome).toMatchObject({ status: 'accepted' })
      expect(await next).toEqual([])
      expect(await journal.read((read) => read.prepare('PRAGMA journal_mode').get())).toEqual({
        journal_mode: 'wal'
      })
    }
    expect(adopted).toBe(true)
    expect(readHost().surfaces.some((surface) => surface.hostTabId === 'chat-tab')).toBe(false)
    await journal.close()
    vi.restoreAllMocks()
    const reopened = await openTestJournalHostDatabase(directory)
    journals.push(reopened)
    expect(
      await reopened.read((read) => read.prepare('SELECT * FROM agent_session_tabs').all())
    ).toEqual([])
    expect(await reopened.read((read) => read.prepare('PRAGMA journal_mode').get())).toEqual({
      journal_mode: 'wal'
    })
  }
)

it('leaves membership unaccepted while a separate WAL snapshot prevents conversion, then retries after release', async () => {
  await oldIndex(true)
  joint()
  const command = closeRequest('external-reader-close')
  const ordinary = await openTestJournalHostDatabase(directory)
  journals.push(ordinary)
  await ordinary.close()
  const before = readHost()
  const writer = await openProfileWriter()
  const reader = new Database(journalDatabasePath(directory), { readonly: true })
  try {
    reader.exec('BEGIN')
    expect(reader.prepare('SELECT session_id FROM agent_session_tabs').all()).toEqual([
      { session_id: sessionId }
    ])
    await expect(
      writer.executeSurfaceJointTransaction({
        journalPath: journalDatabasePath(directory),
        commands: [command]
      })
    ).rejects.toThrow('database is locked')
    expect(readHost()).toEqual(before)
    expect(reader.prepare('SELECT session_id FROM agent_session_tabs').all()).toEqual([
      { session_id: sessionId }
    ])
  } finally {
    reader.close()
  }
  const [accepted] = await writer.executeSurfaceJointTransaction({
    journalPath: journalDatabasePath(directory),
    commands: [command]
  })
  expect(accepted.outcome).toMatchObject({ status: 'accepted' })
  expect(readHost().surfaces.some((surface) => surface.hostTabId === 'chat-tab')).toBe(false)
})

it.each([
  ['before-begin', false],
  ['before-commit', false],
  ['after-commit', true],
  ['after-detach', true]
] as const)('recovers both memberships after writer exit at %s', async (cut, committed) => {
  await oldIndex(true)
  joint()
  const command = closeRequest(`writer-exit-${cut}`)
  const ordinary = await openTestJournalHostDatabase(directory)
  journals.push(ordinary)
  await ordinary.close()
  const marker = join(directory, 'writer-cut.txt')
  const script = join(directory, 'writer-exit.cjs')
  writeFileSync(
    script,
    `
      const { DatabaseSync } = require('node:sqlite')
      const exec = DatabaseSync.prototype.exec
      const cut = ${JSON.stringify(cut)}
      function exit() {
        require('node:fs').writeFileSync(${JSON.stringify(marker)}, cut)
        process.exit(13)
      }
      DatabaseSync.prototype.exec = function(sql) {
        const attached = this.prepare('PRAGMA database_list').all().some(row => row.name === 'surface_chat')
        if (attached && ((cut === 'before-begin' && sql === 'BEGIN IMMEDIATE') ||
            (cut === 'before-commit' && sql === 'COMMIT'))) exit()
        const result = exec.call(this, sql)
        if (attached && ((cut === 'after-commit' && sql === 'COMMIT') ||
            (cut === 'after-detach' && sql === 'DETACH DATABASE surface_chat'))) exit()
        return result
      }
      require(${JSON.stringify(join(bundleRoot, 'profile-state-writer-worker-entry.js'))})
    `
  )
  const writer = await openProfileWriter(script)
  const failure = await writer
    .executeSurfaceJointTransaction({
      journalPath: journalDatabasePath(directory),
      commands: [command]
    })
    .catch((error: unknown) => error)
  expect(profileStateWriterFailureOutcome(failure)).toBe('indeterminate')
  await writer.close()
  worker = undefined
  expect(readFileSync(marker, 'utf8')).toBe(cut)
  authority = new ProfileStateSqliteAuthority(databasePath, 'joint-test')
  authority.readInitialState()
  expect(readHost().surfaces.some((surface) => surface.hostTabId === 'chat-tab')).toBe(!committed)
  const reopened = await openTestJournalHostDatabase(directory)
  journals.push(reopened)
  expect(
    await reopened.read((read) => read.prepare('SELECT session_id FROM agent_session_tabs').all())
  ).toEqual(committed ? [] : [{ session_id: sessionId }])
  expect(
    await reopened.read((read) =>
      read.prepare('SELECT session_id FROM agent_session_records').all()
    )
  ).toEqual([{ session_id: sessionId }])
  expect(await reopened.read((read) => read.prepare('PRAGMA journal_mode').get())).toEqual({
    journal_mode: 'wal'
  })
})

it.each([20, 200])(
  'bounds native catalog reads for %i chats on unchanged initialization and one close',
  async (count) => {
    const records = Array.from({ length: count }, (_, index) =>
      agentSessionRecordFixture({
        sessionId: `chat-${index.toString(16).padStart(8, '0')}`,
        location: { executionHostId: 'local', workspaceId, workspaceKind: 'folder' }
      })
    )
    await seedTestAgentSessionRecordStore(directory, {
      records,
      sessionTabs: records.map((record, index) => ({
        sessionId: record.sessionId,
        tabId: `chat-${index}`
      }))
    })
    await closeTestJournalHostDatabase(directory)
    joint()
    let reads = 0
    let decoded = 0
    const original = WorkspaceSurfaceRepository.prototype.all
    const spy = vi.spyOn(WorkspaceSurfaceRepository.prototype, 'all').mockImplementation(function (
      this: WorkspaceSurfaceRepository,
      hostId
    ) {
      const result = original.call(this, hostId)
      reads++
      decoded += result.length
      return result
    })
    try {
      const [unchanged] = joint()
      expect(
        unchanged.host.surfaces.filter((row) => row.content?.kind === 'agent-session')
      ).toHaveLength(count)
      expect(reads).toBeGreaterThan(0)
      expect(reads).toBeLessThanOrEqual(8)
      expect(decoded).toBeGreaterThanOrEqual(count)
      expect(decoded).toBeLessThanOrEqual(8 * count)
      reads = 0
      decoded = 0
      const [closed] = joint([closeRequest('scaling-close')])
      expect(
        closed.host.surfaces.filter((row) => row.content?.kind === 'agent-session')
      ).toHaveLength(count - 1)
      expect(reads).toBeGreaterThan(0)
      expect(reads).toBeLessThanOrEqual(8)
      expect(decoded).toBeGreaterThanOrEqual(count)
      expect(decoded).toBeLessThanOrEqual(8 * count)
    } finally {
      spy.mockRestore()
    }
  }
)

it('accepts the first recorded native row for a duplicate conversation and keeps later joint actions usable', async () => {
  await oldIndex(true)
  const fixture = new Database(journalDatabasePath(directory))
  try {
    fixture
      .prepare('INSERT INTO agent_session_tabs(tab_id, session_id, position) VALUES (?, ?, ?)')
      .run('duplicate-tab', sessionId, 100)
  } finally {
    fixture.close()
  }
  expect(() => joint()).not.toThrow()
  const native = readHost().surfaces.filter((surface) => surface.content?.kind === 'agent-session')
  expect(native).toEqual([
    expect.objectContaining({
      hostTabId: 'chat-tab',
      content: { kind: 'agent-session', sessionId, agent: 'codex' }
    })
  ])
  expect(() => joint()).not.toThrow()
})

const leafId = '339343d0-9fcb-4d4d-8bf6-69615be0f927'
it.each(['window-group', undefined])(
  'retains first-create group placement %s through split and reopen',
  (groupId) => {
    let db = openWritableProfileStateDatabase(databasePath, 'joint-test').db
    try {
      executeSurfaceOwnerCommand(db, readProfileStateRevision(db), {
        type: 'initialize',
        hostId: 'local'
      })
      const session = getDefaultWorkspaceSession()
      if (groupId) {
        session.tabGroups = {
          folder: [{ id: groupId, worktreeId: 'folder', activeTabId: null, tabOrder: [] }]
        }
      }
      const create = executeSurfaceOwnerCommand(
        db,
        readProfileStateRevision(db),
        {
          type: 'layout',
          hostId: 'local',
          session,
          facts: { startingLeafIds: [], bindings: [] },
          request: {
            hostId: 'local',
            callerId: 'first-create',
            commandId: 'create',
            expiresAt: 100,
            targets: [{ workspaceId: 'folder', hostTabId: 'container', expected: null }],
            command: {
              type: 'createTerminalTab',
              workspace: 'folder',
              tabId: 'container',
              leafId,
              ...(groupId ? { groupId } : {})
            }
          }
        },
        undefined,
        () => 10
      ).result
      expect(create.outcome).toMatchObject({ status: 'accepted' })
      const groups = create.session.tabGroups?.folder
      expect(groups).toHaveLength(1)
      if (groupId) {
        expect(groups?.[0]?.id).toBe(groupId)
      }
      const current = create.host.surfaces.find((row) => row.hostTabId === 'container')!
      if (current.content?.kind !== 'terminal') {
        throw new Error('Expected created terminal')
      }
      const leaf = current.content.leaves[leafId]!
      const split = executeSurfaceOwnerCommand(
        db,
        readProfileStateRevision(db),
        {
          type: 'layout',
          hostId: 'local',
          session: create.session,
          facts: { startingLeafIds: [], bindings: [] },
          request: {
            hostId: 'local',
            callerId: 'first-create',
            commandId: 'split',
            expiresAt: 100,
            targets: [
              {
                workspaceId: 'folder',
                hostTabId: 'container',
                expected: { occurrence: current.occurrence },
                leaf: { leafId, occurrence: leaf.occurrence, runId: leaf.runId }
              }
            ],
            command: {
              type: 'splitPane',
              workspace: 'folder',
              tabId: 'container',
              leafId,
              newLeafId: '22222222-2222-4222-8222-222222222222',
              direction: 'horizontal'
            }
          }
        },
        undefined,
        () => 10
      ).result
      expect(split.outcome).toMatchObject({ status: 'accepted' })
      expect(split.session.tabGroups?.folder).toEqual(groups)
      db.close()
      db = openWritableProfileStateDatabase(databasePath, 'joint-test').db
      const reopened = executeSurfaceOwnerCommand(db, readProfileStateRevision(db), {
        type: 'query',
        hostId: 'local'
      }).result
      expect(reopened.session.tabGroups?.folder).toEqual(groups)
      expect(reopened.session.terminalLayoutsByTabId.container?.root?.type).toBe('split')
    } finally {
      db.close()
    }
  }
)
