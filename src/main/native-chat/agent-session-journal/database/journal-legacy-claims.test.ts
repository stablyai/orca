import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { recoverJournalLegacyClaims } from './journal-legacy-claims'
import { recordJournalLegacyFailure } from './journal-legacy-reconcile-marks'
import {
  initializeJournalDomainDatabase,
  openJournalDomainDatabase
} from './journal-domain-database'
import { journalDatabasePath, journalDomainDatabasePath } from './journal-host-database'
import { openJournalDatabase } from './journal-database'
import { reconcileJournalLegacySource } from './journal-legacy-reconcile'
import { publishJournalSessionEpoch } from '../durable-rows/journal-row-table'
import { assertLegacyStoreReady } from '../journal-legacy-proof-copies'

const cleanup: (() => void)[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).toReversed()) {
    close()
  }
})

it.each([true, false])(
  'keeps recordless claims and isolates refusals with original history=%s',
  async (history) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-legacy-reconcile-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const { db: source } = openJournalDatabase(journalDatabasePath(root))
    cleanup.push(() => source.close())
    const record = source.prepare('INSERT INTO agent_session_records VALUES(?,?)')
    record.run('kept-failed', '{}')
    record.run('kept-healthy', '{}')
    for (const id of ['kept-failed', 'kept-healthy']) {
      publishJournalSessionEpoch(source, { sessionId: id, workspaceId: 'workspace' }, 'original')
    }
    const filename = await initializeJournalDomainDatabase(root)
    const { db } = openJournalDomainDatabase(filename)
    cleanup.push(() => db.close())
    for (const id of ['kept-failed', 'kept-healthy']) {
      db.prepare("UPDATE journal_chat_state SET epoch='converted' WHERE session_id=?").run(id)
    }
    source.exec('DELETE FROM agent_session_records')
    if (!history) {
      source.exec('DELETE FROM journal_sessions')
    }
    const claim = source.prepare('INSERT INTO agent_session_attachment_claims VALUES(?,?,?)')
    claim.run('refused', 'kept-failed', 100)
    claim.run('claimed', 'kept-healthy', 100)
    db.exec(`CREATE TRIGGER refused BEFORE INSERT ON agent_session_attachment_claims
    WHEN NEW.upload_id='refused' BEGIN SELECT RAISE(ABORT,'upload unavailable'); END`)
    reconcileJournalLegacySource(root, db)
    expect(
      db.prepare('SELECT upload_id,session_id FROM agent_session_attachment_claims').all()
    ).toEqual([{ upload_id: 'claimed', session_id: 'kept-healthy' }])
    const failure = db.prepare('SELECT value FROM agent_session_store_meta WHERE key=?')
    expect(JSON.parse(String(failure.get('journal.legacy-failed:kept-failed')?.value)).error).toBe(
      'upload unavailable'
    )
    expect(failure.get('journal.legacy-failed:kept-healthy')).toBeUndefined()
    expect(() => assertLegacyStoreReady(source, db, false)).toThrow('could not be kept')
    db.exec('DROP TRIGGER refused')
    reconcileJournalLegacySource(root, db)
    expect(
      db.prepare('SELECT upload_id,session_id FROM agent_session_attachment_claims').all()
    ).toEqual([{ upload_id: 'claimed', session_id: 'kept-healthy' }])
    source.exec("DELETE FROM agent_session_attachment_claims WHERE session_id='kept-failed'")
    reconcileJournalLegacySource(root, db)
    expect(failure.get('journal.legacy-failed:kept-failed')).toBeUndefined()
    expect(() => assertLegacyStoreReady(source, db, false)).not.toThrow()
  }
)

it.each([11, 10])(
  'keeps every enumerated claim after a source record page fails with SQLite code %i',
  async (errcode) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-legacy-reconcile-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const { db: source } = openJournalDatabase(journalDatabasePath(root))
    cleanup.push(() => source.close())
    await initializeJournalDomainDatabase(root)
    const { db } = openJournalDomainDatabase(journalDomainDatabasePath(root))
    cleanup.push(() => db.close())
    const record = source.prepare('INSERT INTO agent_session_records VALUES(?,?)')
    record.run('broken-page', '{}')
    record.run('later-chat', '{}')
    source
      .prepare('INSERT INTO agent_session_attachment_claims VALUES(?,?,?)')
      .run('later-upload', 'later-chat', 100)
    const prepare = Database.prototype.prepare
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql
    ) {
      const statement = prepare.call(this, sql)
      if (sql !== 'SELECT record_json FROM agent_session_records WHERE session_id=?') {
        return statement
      }
      return {
        get: (...parameters) => {
          if (parameters[0] === 'broken-page') {
            throw Object.assign(new Error('unreadable source page'), {
              code: 'ERR_SQLITE_ERROR',
              errcode
            })
          }
          return statement.get(...parameters)
        },
        all: statement.all.bind(statement),
        run: statement.run.bind(statement),
        iterate: statement.iterate.bind(statement),
        setReadBigInts: statement.setReadBigInts.bind(statement)
      }
    })
    reconcileJournalLegacySource(root, db)
    expect(
      db.prepare('SELECT upload_id,session_id FROM agent_session_attachment_claims').all()
    ).toEqual([{ upload_id: 'later-upload', session_id: 'later-chat' }])
    expect(
      db.prepare("SELECT 1 FROM agent_session_records WHERE session_id='later-chat'").get()
    ).toBeUndefined()
  }
)

it('never commits salvaged custody without its failure hold when a trigger rolls back', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-legacy-reconcile-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const { db } = openJournalDomainDatabase(journalDomainDatabasePath(root))
  cleanup.push(() => db.close())
  db.exec(`CREATE TRIGGER refused BEFORE INSERT ON agent_session_attachment_claims
    WHEN NEW.upload_id='refused' BEGIN SELECT RAISE(ROLLBACK,'upload unavailable'); END;
    CREATE TRIGGER full_disk BEFORE INSERT ON agent_session_store_meta
    WHEN NEW.key='journal.legacy-failed:unadopted' BEGIN SELECT RAISE(ABORT,'disk I/O error'); END`)
  expect(() =>
    recoverJournalLegacyClaims(
      db,
      'unadopted',
      [
        { upload_id: 'good', claimed_at: 100 },
        { upload_id: 'refused', claimed_at: 100 }
      ],
      (claims) =>
        recordJournalLegacyFailure(db, {
          sessionId: 'unadopted',
          revision: 'revision',
          error: 'upload unavailable',
          claims
        })
    )
  ).toThrow('disk I/O error')
  expect(db.prepare('SELECT upload_id FROM agent_session_attachment_claims').all()).toEqual([])
})

it('resumes unattempted custody after transaction-ending recovery is interrupted', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-legacy-reconcile-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const { db } = openJournalDomainDatabase(journalDomainDatabasePath(root))
  cleanup.push(() => db.close())
  db.exec(`CREATE TRIGGER refused BEFORE INSERT ON agent_session_attachment_claims
    WHEN NEW.upload_id='refused' BEGIN SELECT RAISE(ROLLBACK,'upload unavailable'); END`)
  const claims = [
    { upload_id: 'first', claimed_at: 100 },
    { upload_id: 'refused', claimed_at: 100 },
    { upload_id: 'last', claimed_at: 100 }
  ]
  let writes = 0
  const record = (claims: string | null) =>
    recordJournalLegacyFailure(db, {
      sessionId: 'unadopted',
      revision: 'revision',
      error: 'upload unavailable',
      adoption: true,
      claims
    })
  expect(() =>
    recoverJournalLegacyClaims(db, 'unadopted', claims, (claims) => {
      if (++writes === 2) {
        throw Object.assign(new Error('disk I/O error'), { errcode: 10 })
      }
      record(claims)
    })
  ).toThrow('disk I/O error')
  expect(db.prepare('SELECT upload_id FROM agent_session_attachment_claims').all()).toEqual([
    { upload_id: 'first' }
  ])
  expect(
    JSON.parse(
      String(
        db
          .prepare('SELECT value FROM agent_session_store_meta WHERE key=?')
          .get('journal.legacy-failed:unadopted')?.value
      )
    )
  ).toMatchObject({ claims: 'pending' })
  recoverJournalLegacyClaims(db, 'unadopted', claims, record)
  expect(
    db.prepare('SELECT upload_id FROM agent_session_attachment_claims ORDER BY upload_id').all()
  ).toEqual([{ upload_id: 'first' }, { upload_id: 'last' }])
})

it.each(['copy-due', 'stranded'])(
  'resumes interrupted %s custody on an unchanged source',
  async (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-legacy-reconcile-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const { db: original } = openJournalDatabase(journalDatabasePath(root))
    cleanup.push(() => original.close())
    original.prepare('INSERT INTO agent_session_records VALUES(?,?)').run('chat', '{}')
    const filename = await initializeJournalDomainDatabase(root)
    let { db } = openJournalDomainDatabase(filename)
    for (const upload of ['first', 'refused', 'last']) {
      original
        .prepare('INSERT INTO agent_session_attachment_claims VALUES(?,?,?)')
        .run(upload, 'chat', 100)
    }
    original.pragma('wal_checkpoint(TRUNCATE)')
    db.exec(`CREATE TRIGGER refused BEFORE INSERT ON agent_session_attachment_claims
    BEGIN SELECT RAISE(ROLLBACK,'upload unavailable'); END`)
    reconcileJournalLegacySource(root, db)
    db.exec('DROP TRIGGER refused')
    if (kind === 'copy-due') {
      db.prepare('INSERT INTO agent_session_store_meta VALUES(?,?)').run(
        'journal.legacy-copy-due:chat',
        '1'
      )
    } else {
      db.prepare('INSERT INTO journal_chat_state(session_id,workspace_id,epoch) VALUES(?,?,?)').run(
        'copy',
        'workspace',
        'epoch'
      )
      db.prepare('INSERT INTO agent_session_store_meta VALUES(?,?)').run(
        'journal.legacy-copy-source:copy',
        'chat'
      )
    }
    db.function('interrupt_recovery', () => {
      throw Object.assign(new Error('disk I/O error'), { errcode: 10 })
    })
    db.exec(`CREATE TRIGGER refused BEFORE INSERT ON agent_session_attachment_claims
      WHEN NEW.upload_id='refused' BEGIN SELECT RAISE(ROLLBACK,'upload unavailable'); END;
    CREATE TRIGGER interrupted BEFORE INSERT ON agent_session_attachment_claims
      WHEN NEW.upload_id='last' BEGIN SELECT interrupt_recovery(); END`)
    reconcileJournalLegacySource(root, db)
    expect(db.prepare('SELECT upload_id FROM agent_session_attachment_claims').all()).toEqual([
      { upload_id: 'first' }
    ])
    db.exec('DROP TRIGGER interrupted')
    db.close()
    await initializeJournalDomainDatabase(root)
    db = openJournalDomainDatabase(filename).db
    cleanup.push(() => db.close())
    expect(
      db.prepare('SELECT upload_id FROM agent_session_attachment_claims ORDER BY upload_id').all()
    ).toEqual([{ upload_id: 'first' }, { upload_id: 'last' }])
  }
)
