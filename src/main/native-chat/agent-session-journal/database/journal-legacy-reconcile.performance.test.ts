import { linkSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { openJournalDatabase, runJournalTransaction } from './journal-database'
import {
  initializeJournalDomainDatabase,
  openJournalDomainDatabase
} from './journal-domain-database'
import { journalDatabasePath, journalDomainDatabasePath } from './journal-host-database'
import { reconcileJournalLegacySource } from './journal-legacy-reconcile'
import { publishJournalSessionEpoch } from '../durable-rows/journal-row-table'
import { recoverJournalLegacyClaims } from './journal-legacy-claims'
import * as legacyClaims from './journal-legacy-claims'
import {
  JOURNAL_LEGACY_COPY_DUE,
  recordJournalLegacyFailure
} from './journal-legacy-reconcile-marks'
import { fakeLease, profile } from '../journal-legacy-retirement.test-fixture'

const cleanup: (() => void)[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).toReversed()) {
    close()
  }
})

function reads(db: Database.Database, counted: (sql: string, key: unknown) => boolean) {
  let total = 0
  let writes = 0
  const prepare = db.prepare
  vi.spyOn(db, 'prepare').mockImplementation(function (this: Database.Database, sql) {
    const statement = prepare.call(this, sql)
    return {
      get: (...parameters: Parameters<typeof statement.get>) => {
        total += Number(counted(sql, parameters[0]))
        return statement.get(...parameters)
      },
      all: (...parameters: Parameters<typeof statement.all>) => {
        const rows = statement.all(...parameters)
        total += counted(sql, parameters[0]) ? rows.length : 0
        return rows
      },
      run: (...parameters: Parameters<typeof statement.run>) => {
        writes++
        return statement.run(...parameters)
      },
      iterate: statement.iterate.bind(statement),
      setReadBigInts: statement.setReadBigInts.bind(statement)
    }
  })
  return {
    total: () => total,
    writes: () => writes,
    reset: () => {
      total = 0
      writes = 0
    }
  }
}

it('does not retry recordless claim refusals during retirement', async () => {
  const count = 100
  const state = await profile()
  const { db: source } = openJournalDatabase(state.filename)
  const claim = source.prepare('INSERT INTO agent_session_attachment_claims VALUES(?,?,?)')
  const record = state.db.prepare('INSERT INTO agent_session_records VALUES(?,?)')
  for (let index = 0; index < count; index++) {
    const id = `claim-only-${index}`
    claim.run(`refused-${index}`, id, 100)
    record.run(id, '{}')
  }
  let writes = 0
  state.db.function('refused_attempt', () => {
    writes++
    return 1
  })
  state.db.exec(`CREATE TRIGGER refused BEFORE INSERT ON agent_session_attachment_claims
    WHEN refused_attempt() BEGIN SELECT RAISE(ABORT,'upload unavailable'); END`)
  source.close()
  reconcileJournalLegacySource(state.root, state.db)
  writes = 0
  let eligibility = 0
  for (let launch = 0; launch < 3; launch++) {
    await state
      .launch('1.0.1', true, fakeLease, {
        present: () => {},
        check: async () => {
          eligibility++
        }
      })
      .run()
  }
  expect(eligibility).toBe(1)
  expect(writes).toBe(0)
  expect(
    state.db.prepare('SELECT COUNT(*) AS held FROM agent_session_attachment_claims').get()
  ).toEqual({
    held: 0
  })
})

it('does not inventory unrelated failures for one forced copy', async () => {
  const count = 100
  const root = mkdtempSync(join(tmpdir(), 'legacy-forced-perf-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const { db: source } = openJournalDatabase(journalDatabasePath(root))
  cleanup.push(() => source.close())
  const insert = source.prepare('INSERT INTO agent_session_records VALUES(?,?)')
  insert.run('forced', '{}')
  for (let index = 0; index < count; index++) {
    insert.run(`failed-${index}`, '{}')
  }
  const filename = await initializeJournalDomainDatabase(root)
  const { db } = openJournalDomainDatabase(filename)
  cleanup.push(() => db.close())
  for (let index = 0; index < count; index++) {
    recordJournalLegacyFailure(db, {
      sessionId: `failed-${index}`,
      revision: 'null',
      error: 'record refused'
    })
  }
  db.prepare('INSERT INTO agent_session_store_meta VALUES(?,?)').run(
    `${JOURNAL_LEGACY_COPY_DUE}forced`,
    '1'
  )
  const counted = (sql: string, key: unknown) =>
    (sql.includes('SELECT key FROM agent_session_store_meta') &&
      key === 'journal.legacy-failed:') ||
    (sql.includes('SELECT 1 FROM agent_session_records') &&
      typeof key === 'string' &&
      key.startsWith('failed-'))
  const failureReads = reads(Database.prototype, counted)
  reconcileJournalLegacySource(root, db)
  expect(failureReads.total()).toBe(0)
  expect(
    db
      .prepare('SELECT value FROM agent_session_store_meta WHERE key=?')
      .get(`${JOURNAL_LEGACY_COPY_DUE}forced`)
  ).toBeUndefined()
})

it('reads each unchanged chat failure once', async () => {
  const count = 100
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

it('bounds transaction-ending recovery reads by its claim count', () => {
  const count = 100
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

it('fingerprints changed custody once before retrying claims', async () => {
  const count = 100
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

/**
 * Per-launch reads and writes over a damaged original of `count` chats converted here and `count`
 * the older Orca added after, and what it recorded. A second link leaves its identity uncertifiable.
 */
async function damagedOriginalLaunches(count: number, damage: string, linked: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'legacy-damaged-perf-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const { db: source } = openJournalDatabase(journalDatabasePath(root))
  const addChats = (prefix: string) =>
    runJournalTransaction(source, () => {
      const record = source.prepare('INSERT INTO agent_session_records VALUES(?,?)')
      const claim = source.prepare('INSERT INTO agent_session_attachment_claims VALUES(?,?,?)')
      for (let index = 0; index < count; index++) {
        const sessionId = `${prefix}-${index}`
        publishJournalSessionEpoch(source, { sessionId, workspaceId: 'workspace' }, 'epoch')
        record.run(sessionId, JSON.stringify({ sessionId, lease: { sessionId } }))
        claim.run(`upload-${sessionId}`, sessionId, 100)
      }
    })
  addChats('converted')
  const filename = await initializeJournalDomainDatabase(root)
  const { db } = openJournalDomainDatabase(filename)
  cleanup.push(() => db.close())
  // Deleted here, it keeps its revision and must not be held back.
  db.prepare("DELETE FROM agent_session_records WHERE session_id='converted-0'").run()
  addChats('added')
  source.exec(damage)
  source.close()
  if (linked) {
    linkSync(journalDatabasePath(root), join(root, 'second-link.db'))
  }
  const counted = reads(Database.prototype, () => true)
  const perLaunch: { reads: number; writes: number }[] = []
  for (let launch = 0; launch < 3; launch++) {
    counted.reset()
    reconcileJournalLegacySource(root, db)
    perLaunch.push({ reads: counted.total(), writes: counted.writes() })
  }
  vi.restoreAllMocks()
  const keys = db
    .prepare("SELECT key FROM agent_session_store_meta WHERE key LIKE 'journal.legacy-%'")
    .all()
    .map((row) => String(row.key))
  const held = db.prepare('SELECT COUNT(*) AS held FROM agent_session_attachment_claims').get()
  return { perLaunch, keys, held: Number(held!.held) }
}

it.each([
  [
    'its record tables',
    'DROP TABLE agent_session_command_receipts; DROP TABLE agent_session_records',
    false
  ],
  ['its history sessions', 'DROP TABLE journal_sessions', false],
  ['its history sessions, with an uncertifiable identity,', 'DROP TABLE journal_sessions', true]
])(
  'records a version-four original missing %s once and keeps its uploads claimed',
  async (_, damage, linked) => {
    const small = await damagedOriginalLaunches(20, damage, linked)
    const large = await damagedOriginalLaunches(200, damage, linked)
    for (const [size, { perLaunch, keys, held }] of [
      [20, small],
      [200, large]
    ] as const) {
      expect(held).toBe(2 * size)
      // Only chats never shown here hold their uploads with a failure record.
      expect(keys.filter((key) => key.startsWith('journal.legacy-failed:')).sort()).toEqual(
        Array.from({ length: size }, (_, index) => `journal.legacy-failed:added-${index}`).sort()
      )
      expect(keys).toContain('journal.legacy-source-damaged.v1')
      // Later launches write nothing: the claims are kept and the file is recorded.
      expect(perLaunch.slice(1).map(({ writes }) => writes)).toEqual([0, 0])
    }
    // #46001: the first launch reads each chat a few times; later ones skip the recorded file.
    expect(small.perLaunch[0].reads).toBeLessThanOrEqual(270)
    expect(large.perLaunch[0].reads).toBeLessThanOrEqual(2070)
    const later = (launches: { reads: number }[]) => launches.slice(1).map(({ reads }) => reads)
    if (linked) {
      // Without an identity to compare, each launch rechecks the claims, linearly and read-only.
      expect(Math.max(...later(small.perLaunch))).toBeLessThanOrEqual(230)
      expect(Math.max(...later(large.perLaunch))).toBeLessThanOrEqual(1670)
    } else {
      expect(later(small.perLaunch)).toEqual([3, 3])
      expect(later(large.perLaunch)).toEqual([3, 3])
    }
  }
)
