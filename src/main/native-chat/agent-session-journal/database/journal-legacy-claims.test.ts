import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { recoverJournalLegacyClaims } from './journal-legacy-claims'
import { recordJournalLegacyFailure } from './journal-legacy-reconcile-marks'
import { openJournalDomainDatabase } from './journal-domain-database'
import { journalDomainDatabasePath } from './journal-host-database'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) {
    close()
  }
})

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
