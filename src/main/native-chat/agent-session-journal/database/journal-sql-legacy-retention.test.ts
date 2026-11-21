import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { acquireOrcadInstanceLock } from '../../../orcad/instance-lock/orcad-instance-lock'
import { openJournalDatabase } from './journal-database'
import { journalDatabasePath } from './journal-host-database'
import { JournalSqlDatabase } from './journal-sql-database'
import { publishJournalSessionEpoch } from '../durable-rows/journal-row-table'
import { publishJournalOutcomeEpoch } from '../outcomes/journal-outcome-epoch.test-fixture'
import { journalSqlLifecycleRows } from '../journal-sql-reducer-rows.test-fixture'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from '../journal-sql-worker-bundle.test-fixture'
import { withTestAgentSessionDatabase } from '../../../runtime/agent-session/records/agent-session-record-store-persistence.test-fixture'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'

// These cover the deletion a later build turns back on; this build keeps the file.
vi.mock('../journal-legacy-retirement-deletion', () => ({
  LEGACY_JOURNAL_RETIREMENT_DELETES: true
}))

const roots: string[] = []
const databases: JournalSqlDatabase[] = []
const locks: ReturnType<typeof acquireOrcadInstanceLock>[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(databases.splice(0).map((database) => database.close()))
  for (const lock of locks.splice(0)) {
    lock.release()
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function open(root: string, errors: unknown[]) {
  const database = await JournalSqlDatabase.open(root, {
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath(),
    onMaintenanceError: (error) => errors.push(error)
  })
  databases.push(database)
  return database
}

async function fixture(seed?: (db: ReturnType<typeof openJournalDatabase>['db']) => void) {
  const root = await mkdtemp(join(tmpdir(), 'journal-legacy-retained-'))
  roots.push(root)
  locks.push(
    acquireOrcadInstanceLock(root, {
      identity: () => 'retention-test',
      machineIdentity: () => 'retention-test',
      startedAtMs: () => 1000,
      incarnation: () => null,
      version: () => 'test',
      enforcePrivateDataRoot: false
    })
  )
  const filename = journalDatabasePath(root)
  const { db } = openJournalDatabase(filename)
  publishJournalSessionEpoch(db, { sessionId: 'saved', workspaceId: 'folder' }, 'old-epoch')
  publishJournalOutcomeEpoch(db, 'saved', 'old-epoch', journalSqlLifecycleRows())
  publishJournalSessionEpoch(db, { sessionId: 'empty', workspaceId: 'folder' }, 'empty-epoch')
  seed?.(db)
  db.close()
  const errors: unknown[] = []
  const database = await open(root, errors)
  return { root, filename, database, errors }
}

async function saveRetirement(root: string, phase: string, manifest?: unknown) {
  return withTestAgentSessionDatabase(root, (db) => {
    const proof = String(
      db
        .prepare('SELECT value FROM agent_session_store_meta WHERE key=?')
        .get('journal.legacy-source-copy.v1')!.value
    )
    const value = JSON.stringify({
      version: 1,
      proof,
      proofId: 'prior-proof',
      process: 'prior-process',
      completedAt: 1000,
      lastWall: 1000,
      credit: 604800000,
      creditRevision: 1,
      phase,
      ...(manifest ? { manifest } : {})
    })
    db.prepare('INSERT OR REPLACE INTO agent_session_store_meta VALUES(?,?)').run(
      'journal.legacy-retirement.v1',
      value
    )
    return value
  })
}

const identity = {
  sessionId: 'empty',
  workspaceId: 'folder',
  hostId: 'host',
  agent: 'codex' as const,
  providerHandle: codexProviderHandle('thread')
}

it('converts an empty legacy chat with its saved epoch before maintenance and keeps it after reopen', async () => {
  const { root, database, errors } = await fixture()
  expect(await database.ensureSessionEpoch('empty')).toBe('empty-epoch')
  expect(await database.ensureSessionEpoch('missing')).toBeNull()
  await database.close()
  const reopened = await open(root, errors)
  expect((await reopened.openSession(identity)).target.epoch).toBe('empty-epoch')
  expect(errors).toEqual([])
})

it('keeps queued-only zero-sequence source conversion unchanged', async () => {
  const { database } = await fixture((db) => {
    db.prepare(`INSERT INTO queued_messages
      (session_id,message_id,position,body_json,fingerprint,created_at,host_instance,state)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      'empty',
      'queued',
      1,
      '{"kind":"message","role":"user","blocks":[{"type":"text","text":"keep queued"}]}',
      'fingerprint',
      1000,
      'prior-host',
      'waiting'
    )
  })
  expect(await database.ensureSessionEpoch('empty')).toBeNull()
})

const savedV1 = (root: string) =>
  withTestAgentSessionDatabase(
    root,
    (db) =>
      db
        .prepare('SELECT value FROM agent_session_store_meta WHERE key=?')
        .get('journal.legacy-retirement.v1')!.value
  )

it.each(['grace', 'prepared', 'complete'])(
  'keeps the original on the version that copied it, leaving a saved %s row untouched',
  async (phase) => {
    vi.stubEnv('ORCA_APP_VERSION', '1.0.0')
    const { root, filename, database, errors } = await fixture()
    await database.ensureSessionEpoch('saved')
    const bytes = await readFile(filename)
    const saved = await saveRetirement(root, phase)
    await database.startMaintenance()
    await database.close()
    const reopened = await open(root, errors)
    await reopened.startMaintenance()
    await reopened.close()
    expect(await readFile(filename)).toEqual(bytes)
    expect(await savedV1(root)).toBe(saved)
    expect(errors).toEqual([])
  }
)

it.skipIf(process.env.ORCA_JOURNAL_NATIVE_LOCK_TEST !== '1')(
  'deletes the original on the next version through the real workers and lock, keeping every chat',
  async () => {
    vi.stubEnv('ORCA_APP_VERSION', '1.0.0')
    const { root, filename, database, errors } = await fixture()
    await database.close()
    const saved = await saveRetirement(root, 'grace')
    vi.stubEnv('ORCA_APP_VERSION', '1.0.1')
    const updated = await open(root, errors)
    await updated.startMaintenance()
    expect(errors).toEqual([])
    expect([filename, `${filename}-wal`, `${filename}-shm`].filter((f) => existsSync(f))).toEqual(
      []
    )
    await updated.close()
    const reopened = await open(root, errors)
    expect(await reopened.ensureSessionEpoch('saved')).toBe('old-epoch')
    expect((await reopened.openSession(identity)).target.epoch).toBe('empty-epoch')
    expect(await savedV1(root)).toBe(saved)
    expect(errors).toEqual([])
  }
)

it('removes only an empty WAL and the SHM a removal left behind its main file', async () => {
  const { root, filename, database, errors } = await fixture()
  await database.startMaintenance()
  await database.close()
  await unlink(filename)
  await writeFile(`${filename}-wal`, '')
  await writeFile(`${filename}-shm`, 'stale shared memory')
  const saved = await saveRetirement(root, 'prepared')
  const reopened = await open(root, errors)
  await reopened.startMaintenance()
  await reopened.close()
  expect([filename, `${filename}-wal`, `${filename}-shm`].filter((f) => existsSync(f))).toEqual([])
  expect(await savedV1(root)).toBe(saved)
  expect(errors).toEqual([])
})
