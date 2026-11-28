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
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { encodeAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/records/agent-session-record-stored-form'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import {
  loadAgentSessionStoreRows,
  writeAgentSessionStoreRows
} from '../../../runtime/agent-session/records/agent-session-record-rows'
import { hasPersistedStructuredAgentSessionStore } from '../../../runtime/agent-session/records/agent-session-record-store-slot'
import { requireWritableAgentSessionRecord } from '../../../runtime/agent-session/records/agent-session-store-state'
import { agentSessionVisibleTabIndex } from '../../../runtime/agent-session/records/agent-session-tab-table'
import Database from '../../../sqlite/sync-database'
import { agentSessionRecordFixture } from '../../testing/agent-session-record-test-fixture'
import { resolveJournalWriterStoreMutation } from '../journal-writer-store-mutation'
import { journalOpenRefusal } from '../replay/journal-open-failure'
import { runJournalTransaction } from './journal-database'
import {
  createAgentSessionRecordTablesSql,
  createJournalTablesSql
} from './journal-database-schema'
import { initializeJournalDomainDatabase } from './journal-domain-database'
import { journalDatabasePath, journalDomainDatabasePath } from './journal-host-database'
import { journalLegacyRecordPaths } from './journal-legacy-record-paths'

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function profile(version = 3, setup = '') {
  const root = mkdtempSync(join(tmpdir(), 'orca-original-chat-records-'))
  directories.push(root)
  const journal = journalDatabasePath(root)
  const source = new Database(journal)
  try {
    source.exec(createJournalTablesSql())
    source.pragma(`user_version=${version}`)
    source.exec(setup)
  } finally {
    source.close()
  }
  const [primary, backup] = journalLegacyRecordPaths(root)
  mkdirSync(dirname(primary))
  return { root, journal, primary, backup }
}

function stored(sessionId: string, conversationName = 'Saved chat') {
  return encodeAgentSessionRecord(agentSessionRecordFixture({ sessionId, conversationName }))
}

function saveRecords(
  path: string,
  records: Record<string, unknown>,
  options: Record<string, unknown> = {}
) {
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 2,
      hostId: 'local',
      records,
      operations: {},
      retiredClaimKeys: [],
      unusableRecords: {},
      ...options
    })
  )
}

it.each([false, true])(
  'preserves owed v3 SQL values and tab identity (explicit index: %s)',
  async (explicit) => {
    const { root, journal, primary } = profile(3, createAgentSessionRecordTablesSql())
    const source = new Database(journal)
    try {
      source
        .prepare('INSERT INTO agent_session_records VALUES (?,?)')
        .run('owed-chat', JSON.stringify(stored('owed-chat', 'SQL chat')))
      source.exec(`INSERT INTO agent_session_records VALUES('hidden-chat','opaque SQL record');
      INSERT INTO agent_session_tabs VALUES('owed-custom-tab','owed-chat',0);
      INSERT INTO agent_session_store_meta VALUES('session_tabs_recorded','1');
      INSERT INTO agent_session_store_meta VALUES('journal.legacy-revision:owed-chat','saved baseline');
      INSERT INTO journal_sessions VALUES('historical','workspace-1','epoch');
      INSERT INTO journal_rows VALUES('historical','epoch',1,10,'{}');`)
    } finally {
      source.close()
    }
    saveRecords(
      primary,
      {
        'owed-chat': stored('owed-chat', 'Old JSON chat'),
        'hidden-chat': stored('hidden-chat'),
        historical: stored('historical'),
        'draft-chat': stored('draft-chat')
      },
      explicit
        ? {
            sessionTabs: [
              { sessionId: 'historical', tabId: 'historical-custom-tab' },
              { sessionId: 'owed-chat', tabId: 'ignored-owed-tab' },
              { sessionId: 'hidden-chat', tabId: 'ignored-hidden-tab' }
            ]
          }
        : {}
    )
    const before = [readFileSync(journal), readFileSync(primary)]
    const db = new Database(await initializeJournalDomainDatabase(root))
    try {
      const loaded = loadAgentSessionStoreRows(db)
      expect(loaded.records.get('owed-chat')?.conversationName).toBe('SQL chat')
      expect(loaded.unreadableRecords.get('hidden-chat')?.raw).toBe('opaque SQL record')
      expect(loaded.records.get('draft-chat')?.conversationName).toBe('Saved chat')
      expect(
        db
          .prepare('SELECT key,value FROM agent_session_store_meta WHERE key LIKE ? ORDER BY key')
          .all('journal.legacy-revision:%')
      ).toEqual([
        { key: 'journal.legacy-revision:draft-chat', value: 'null' },
        { key: 'journal.legacy-revision:hidden-chat', value: 'null' },
        { key: 'journal.legacy-revision:historical', value: '["epoch",1,null,null]' },
        { key: 'journal.legacy-revision:owed-chat', value: 'saved baseline' }
      ])
      if (!explicit) {
        expect(agentSessionVisibleTabIndex(loaded)).toEqual({
          present: false,
          sessionIds: ['owed-chat']
        })
        runJournalTransaction(db, () => {
          const { writes } = resolveJournalWriterStoreMutation(
            db,
            {
              kind: 'command',
              command: { kind: 'tabs-initialize', legacyTabIds: ['historical'] }
            },
            undefined
          )
          writeAgentSessionStoreRows(db, writes)
        })
      }
      expect(loadAgentSessionStoreRows(db).sessionTabs?.entries()).toEqual(
        explicit
          ? [
              ['historical-custom-tab', 'historical'],
              ['owed-custom-tab', 'owed-chat']
            ]
          : [
              ['owed-custom-tab', 'owed-chat'],
              [structuredAgentSessionTabId('historical'), 'historical']
            ]
      )
      expect([readFileSync(journal), readFileSync(primary)]).toEqual(before)
    } finally {
      db.close()
    }
  }
)

it('refuses indeterminate inputs before publishing, and leaves the same profile eligible for retry', async () => {
  const { root, primary, backup } = profile()
  const available = () => hasPersistedStructuredAgentSessionStore(root)
  expect(available()).toBe(false)
  writeFileSync(primary, '{')
  expect(available()).toBe(true)
  async function refusal(attempt: Promise<string>, reason: string) {
    await expect(attempt.catch(journalOpenRefusal)).resolves.toMatchObject({
      code: 'agent_session_journal_unreadable',
      details: { reason }
    })
    expect(existsSync(journalDomainDatabasePath(root))).toBe(false)
    expect(readdirSync(root).some((name) => name.startsWith('.journal-domain-import-'))).toBe(false)
  }
  await refusal(initializeJournalDomainDatabase(root), 'journalCorrupt')
  saveRecords(backup, { recovered: stored('recovered') })
  saveRecords(primary, {}, { schemaVersion: 3 })
  await refusal(initializeJournalDomainDatabase(root), 'journalWrittenByNewerOrca')
  rmSync(primary)
  mkdirSync(primary)
  await refusal(initializeJournalDomainDatabase(root), 'journalUnavailable')
  rmSync(primary, { recursive: true })
  const attempt = initializeJournalDomainDatabase(root)
  saveRecords(primary, { 'latest-chat': stored('latest-chat') })
  await refusal(attempt, 'journalUnavailable')
  expect(available()).toBe(true)
  const db = new Database(await initializeJournalDomainDatabase(root))
  try {
    expect([...loadAgentSessionStoreRows(db).records.keys()]).toEqual(['latest-chat'])
  } finally {
    db.close()
  }
})

it.each([false, true])(
  'recovers backup records without trusting the backup tab index (whole backup: %s)',
  async (wholeBackup) => {
    const { root, primary, backup } = profile()
    const backupRecord = stored('recovered')
    saveRecords(
      backup,
      { recovered: backupRecord },
      {
        sessionTabs: [{ tabId: 'stale-visible-tab', sessionId: 'recovered' }]
      }
    )
    const opaque = { schemaVersion: 999, valuable: ['opaque', { data: true }] }
    if (wholeBackup) {
      writeFileSync(primary, '{')
    } else {
      saveRecords(
        primary,
        {
          recovered: { ...backupRecord, schemaVersion: 999, lease: { runtimeFence: 80 } },
          'opaque-chat': opaque
        },
        { sessionTabs: [{ tabId: 'opaque-tab', sessionId: 'opaque-chat' }] }
      )
    }
    const db = new Database(await initializeJournalDomainDatabase(root))
    try {
      const state = loadAgentSessionStoreRows(db)
      expect(state.records.get('recovered')?.lease).toMatchObject({
        runtimeFence: 1,
        claimStatus: 'released',
        ownerProcess: null,
        minimumNextFence: wholeBackup ? 3 : 81
      })
      if (wholeBackup) {
        expect(state.sessionTabs).toBeNull()
      } else {
        expect(state.sessionTabs?.entries()).toEqual([['opaque-tab', 'opaque-chat']])
        expect(state.unreadableRecords.get('opaque-chat')?.raw).toEqual(opaque)
        expect(() => requireWritableAgentSessionRecord(state, 'opaque-chat')).toThrow(
          expect.objectContaining({
            refusal: expect.objectContaining({
              code: 'execution_owner_reconciling',
              details: { reason: 'recordUnreadable' }
            })
          })
        )
      }
    } finally {
      db.close()
    }
  }
)

it('does not read newer profiles’ abandoned record files even when a v4 record table is missing', async () => {
  const complete = profile(4, createAgentSessionRecordTablesSql())
  const damaged = profile(4)
  for (const { root, primary } of [complete, damaged]) {
    saveRecords(primary, {}, { schemaVersion: 999 })
    expect(hasPersistedStructuredAgentSessionStore(root)).toBe(false)
  }
  const db = new Database(await initializeJournalDomainDatabase(complete.root))
  try {
    expect(loadAgentSessionStoreRows(db).records.size).toBe(0)
    await expect(initializeJournalDomainDatabase(damaged.root)).rejects.toThrow(
      /agent_session_records/
    )
    expect(existsSync(journalDomainDatabasePath(damaged.root))).toBe(false)
  } finally {
    db.close()
  }
})
