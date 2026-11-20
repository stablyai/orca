import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type Database from '../../../sqlite/sync-database'
import { openJournalDatabase } from './journal-database'
import {
  initializeJournalDomainDatabase,
  openJournalDomainDatabase
} from './journal-domain-database'
import { journalDatabasePath, journalDomainDatabasePath } from './journal-host-database'
import { reconcileJournalLegacySource } from './journal-legacy-reconcile'
import { recoverJournalLegacyClaims } from './journal-legacy-claims'
import * as legacyClaims from './journal-legacy-claims'
import { recordJournalLegacyFailure } from './journal-legacy-reconcile-marks'

const cleanup: (() => void)[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).toReversed()) {
    close()
  }
})

function reads(db: Database.Database, counted: (sql: string, key: unknown) => boolean) {
  let total = 0
  const prepare = db.prepare.bind(db)
  vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql)
    return new Proxy(statement, {
      get(target, property) {
        if (property === 'get') {
          return (...parameters: Parameters<typeof statement.get>) => {
            total += Number(counted(sql, parameters[0]))
            return target.get(...parameters)
          }
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  })
  return {
    total: () => total,
    reset: () => {
      total = 0
    }
  }
}

it.each([10, 100])('reads each unchanged chat failure once across %i chats', async (count) => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-reconcile-perf-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const { db: source } = openJournalDatabase(journalDatabasePath(root))
  cleanup.push(() => source.close())
  const insert = source.prepare('INSERT INTO agent_session_records VALUES(?,?)')
  for (let index = 0; index < count; index++) {
    const sessionId = `chat-${index}`
    insert.run(sessionId, JSON.stringify({ sessionId, lease: { sessionId } }))
  }
  const filename = await initializeJournalDomainDatabase(root)
  const { db } = openJournalDomainDatabase(filename)
  cleanup.push(() => db.close())
  source.prepare('INSERT INTO agent_session_store_meta VALUES(?,?)').run('unrelated', 'write')
  const queries = reads(
    db,
    (sql, key) =>
      sql.includes('agent_session_store_meta') &&
      typeof key === 'string' &&
      key.startsWith('journal.legacy-failed:')
  )
  reconcileJournalLegacySource(root, db)
  expect(queries.total()).toBeLessThanOrEqual(count)
  expect(db.prepare('SELECT COUNT(*) AS count FROM agent_session_records').get()).toEqual({ count })
  queries.reset()
  reconcileJournalLegacySource(root, db)
  expect(queries.total()).toBe(0)
})

it.each([10, 100])('bounds transaction-ending recovery reads by its %i claims', (count) => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-claims-perf-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const { db } = openJournalDomainDatabase(journalDomainDatabasePath(root))
  cleanup.push(() => db.close())
  db.exec(`CREATE TRIGGER refused BEFORE INSERT ON agent_session_attachment_claims
    WHEN NEW.upload_id='refused' BEGIN SELECT RAISE(ROLLBACK,'upload unavailable'); END`)
  const claims = Array.from({ length: count - 1 }, (_, index) => ({
    upload_id: `upload-${index}`,
    claimed_at: 100
  }))
  claims.push({ upload_id: 'refused', claimed_at: 100 })
  const queries = reads(db, (sql) => sql.includes('SELECT 1 FROM agent_session_attachment_claims'))
  recoverJournalLegacyClaims(db, 'chat', claims, (claims) =>
    recordJournalLegacyFailure(db, {
      sessionId: 'chat',
      revision: 'revision',
      error: 'upload unavailable',
      adoption: true,
      claims
    })
  )
  expect(queries.total()).toBeLessThanOrEqual(3 * count)
  expect(db.prepare('SELECT COUNT(*) AS held FROM agent_session_attachment_claims').get()).toEqual({
    held: count - 1
  })
})

it.each([10, 100])('fingerprints changed custody once before retrying %i claims', async (count) => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-claims-perf-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const { db: source } = openJournalDatabase(journalDatabasePath(root))
  cleanup.push(() => source.close())
  source.prepare('INSERT INTO agent_session_records VALUES(?,?)').run('chat', '{}')
  const filename = await initializeJournalDomainDatabase(root)
  const { db } = openJournalDomainDatabase(filename)
  cleanup.push(() => db.close())
  source
    .prepare('INSERT INTO agent_session_attachment_claims VALUES(?,?,?)')
    .run('refused', 'chat', 100)
  db.exec(`CREATE TRIGGER refused BEFORE INSERT ON agent_session_attachment_claims
    WHEN NEW.upload_id='refused' BEGIN SELECT RAISE(ABORT,'upload unavailable'); END`)
  reconcileJournalLegacySource(root, db)
  for (let index = 1; index < count; index++) {
    source
      .prepare('INSERT INTO agent_session_attachment_claims VALUES(?,?,?)')
      .run(`upload-${index}`, 'chat', 100)
  }
  const fingerprints = vi.spyOn(legacyClaims, 'journalLegacyClaimsFingerprint')
  reconcileJournalLegacySource(root, db)
  expect(
    fingerprints.mock.calls.reduce((sum, [claims]) => sum + claims.length, 0)
  ).toBeLessThanOrEqual(count + 1)
  expect(db.prepare('SELECT COUNT(*) AS held FROM agent_session_attachment_claims').get()).toEqual({
    held: count - 1
  })
})
