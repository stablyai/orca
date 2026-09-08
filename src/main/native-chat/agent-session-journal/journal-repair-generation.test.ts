import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import Database from '../../sqlite/sync-database'
import { journalDatabaseFile } from './journal-paths'
import { replayJournal } from './journal-open'
import { openAgentSessionJournal } from './journal-store-factory'
import { createTrackedJournalOpener } from './journal-store-test-open'

const identity: AgentSessionJournalIdentity = {
  sessionId: 'repair-fixture',
  workspaceId: 'folder-or-worktree',
  hostId: 'execution-host',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'disposable-thread' }
}
const journals = createTrackedJournalOpener()
let root: string
let source: string
let original: unknown[]
const item = (id: string) => ({ provider: 'orca' as const, clientMessageId: id })
const body = { kind: 'status' as const, text: 'disposable evidence λ' }
function open() {
  return journals.open({ identity, journalDir: root })
}
function inspect<T>(run: (db: Database.Database) => T): T {
  const db = new Database(journalDatabaseFile(root))
  try {
    return run(db)
  } finally {
    db.close()
  }
}
function raw(db: Database.Database, epoch = source) {
  return db
    .prepare(`SELECT epoch, seq, ts, typeof(row_json) AS storage_type, hex(CAST(row_json AS BLOB)) AS bytes
    FROM journal_rows WHERE epoch = ? ORDER BY seq`)
    .all(epoch)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-repair-generation-'))
  const journal = await open()
  source = journal.epoch
  await journal.appendItem(item('prefix'), body, { fence: 1 })
  await journal.appendItem(item('fault'), body, { fence: 1 })
  await journal.appendSubmission({
    clientMessageId: 'orca-only-receipt',
    payloadFingerprint: 'unique',
    fence: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'only in Orca' }] }
  })
  await journal.resolveDispatch({
    clientMessageId: 'orca-only-receipt',
    state: 'accepted',
    providerIdentity: item('accepted'),
    fence: 1
  })
  await journal.appendItem(item('valid-suffix'), body, { fence: 1 })
  await journal.close()
  inspect((db) => {
    db.prepare('UPDATE journal_rows SET row_json = ? WHERE seq = 3').run('  }{ λ\n')
    original = raw(db)
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

it('seals exact rejected bytes, Orca-only receipt and suffix across reopen and replacement', async () => {
  const repaired = await open()
  expect(repaired.epoch).not.toBe(source)
  expect(repaired.receiptFor('orca-only-receipt')).toBeNull()
  expect(repaired.readSince({ epoch: source, sequence: 2 })).toMatchObject({
    reset: 'epoch_changed'
  })
  inspect((db) => {
    expect(raw(db)).toEqual(original)
    expect(
      db
        .prepare('SELECT row_count, prefix_through, rejected_from FROM journal_recovery_epochs')
        .get()
    ).toMatchObject({ row_count: 6, prefix_through: 2, rejected_from: 3 })
    expect(() => db.prepare('DELETE FROM journal_rows WHERE epoch = ?').run(source)).toThrow(
      'sealed'
    )
    expect(() =>
      db.prepare('UPDATE journal_rows SET row_json = ? WHERE epoch = ?').run('{}', source)
    ).toThrow('sealed')
    expect(() => db.exec('DELETE FROM journal_recovery_epochs')).toThrow('immutable')
  })
  await repaired.close()
  const reopened = await open()
  expect(reopened.snapshot().items.some((entry) => entry.itemId.includes('valid-suffix'))).toBe(
    false
  )
  await reopened.replaceEpochItems('legacy_import', 2, [{ identity: item('provider'), body }])
  await reopened.rollEpoch('handle_forked', 3)
  await reopened.close()
  await open().then((journal) => journal.close())
  inspect((db) => expect(raw(db)).toEqual(original))
})

it.each(['seal', 'prefix', 'publish', 'commit'] as const)(
  'rolls back repair when %s admission fails',
  async (boundary) => {
    const exec = Database.prototype.exec
    const prepare = Database.prototype.prepare
    const sqlBoundary = {
      seal: 'INSERT INTO journal_recovery_epochs',
      prefix: 'INSERT INTO journal_rows',
      publish: 'INSERT INTO journal_sessions',
      commit: undefined
    }[boundary]
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(
      function (this: Database.Database, sql) {
        if (sqlBoundary && sql.startsWith(sqlBoundary)) {
          throw new Error('repair admission refused')
        }
        return prepare.call(this, sql)
      }
    )
    vi.spyOn(Database.prototype, 'exec').mockImplementation(
      function (this: Database.Database, sql) {
        if (boundary === 'commit' && sql === 'COMMIT') {
          throw new Error('repair admission refused')
        }
        return exec.call(this, sql)
      }
    )
    await expect(openAgentSessionJournal({ identity, journalDir: root })).rejects.toThrow(
      'repair admission refused'
    )
    vi.restoreAllMocks()
    inspect((db) => {
      expect(raw(db)).toEqual(original)
      expect(db.prepare('SELECT epoch FROM journal_sessions').get()).toMatchObject({
        epoch: source
      })
      expect(db.prepare('SELECT count(*) AS n FROM journal_recovery_epochs').get()).toMatchObject({
        n: 0
      })
    })
    await open().then((journal) => journal.close())
    inspect((db) => expect(raw(db)).toEqual(original))
  }
)

it('refuses writable repair on a real SQLite page limit without losing source bytes', async () => {
  // Fill a bounded replacement beyond the free page budget, not the host filesystem.
  inspect((db) =>
    db.prepare('UPDATE journal_rows SET row_json = ? WHERE seq = 2').run(
      JSON.stringify({
        v: 1,
        kind: 'item',
        epoch: source,
        seq: 2,
        fence: 1,
        ts: 1,
        itemId: 'large',
        revision: 1,
        body: { kind: 'status', text: 'x'.repeat(200_000) }
      })
    )
  )
  original = inspect((db) => raw(db))
  const exec = Database.prototype.exec
  vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql) {
    if (sql === 'BEGIN IMMEDIATE') {
      const pages = this.pragma('page_count', { simple: true })
      this.pragma(`max_page_count = ${pages}`)
    }
    return exec.call(this, sql)
  })
  await expect(openAgentSessionJournal({ identity, journalDir: root })).rejects.toThrow(/full/i)
  vi.restoreAllMocks()
  inspect((db) => {
    expect(raw(db)).toEqual(original)
    expect(db.prepare('SELECT epoch FROM journal_sessions').get()).toMatchObject({ epoch: source })
  })
})

it.each(['database', 'row', 'v2-row'])(
  'leaves future %s bytes read-only, including behind corruption',
  async (axis) => {
    inspect((db) => {
      if (axis === 'database') {
        db.pragma('user_version = 999')
      } else {
        db.prepare('UPDATE journal_rows SET row_json = ? WHERE seq = 6').run('{"v":999}')
        if (axis === 'v2-row') {
          db.pragma('user_version = 2')
        }
      }
    })
    const before = await readFile(journalDatabaseFile(root))
    const journal = await open()
    expect(journal.isReadOnly).toBe(true)
    await expect(journal.appendItem(item('refused'), body)).rejects.toMatchObject({
      code: 'journal_read_only'
    })
    await journal.close()
    expect(await readFile(journalDatabaseFile(root))).toEqual(before)
  }
)

it('migrates an actual v2 schema and seals its rows without rewriting them', async () => {
  inspect((db) => {
    db.exec(`DROP TRIGGER journal_sealed_row_insert;
      DROP TRIGGER journal_sealed_row_update;
      DROP TRIGGER journal_sealed_row_delete;
      DROP TRIGGER journal_recovery_epoch_update;
      DROP TRIGGER journal_recovery_epoch_delete;
      DROP TABLE journal_recovery_epochs;`)
    db.pragma('user_version = 2')
  })
  const journal = await open()
  expect(journal.isReadOnly).toBe(false)
  await journal.close()
  inspect((db) => {
    expect(raw(db)).toEqual(original)
    expect(db.pragma('user_version', { simple: true })).toBe(3)
    expect(db.prepare('SELECT count(*) AS n FROM journal_recovery_epochs').get()).toMatchObject({
      n: 1
    })
  })
})

it.each([1, 6])('fences future BLOB at seq %s before replay or migration', async (seq) => {
  for (const version of [3, 2]) {
    inspect((db) => {
      if (version === 2) {
        db.exec(`DROP TRIGGER journal_sealed_row_insert;
          DROP TRIGGER journal_sealed_row_update;
          DROP TRIGGER journal_sealed_row_delete;
          DROP TRIGGER journal_recovery_epoch_update;
          DROP TRIGGER journal_recovery_epoch_delete;
          DROP TABLE journal_recovery_epochs;`)
      }
      db.pragma(`user_version = ${version}`)
      db.prepare('UPDATE journal_rows SET row_json = ? WHERE seq = ?').run(
        Buffer.from('{"v":999}'),
        seq
      )
      original = raw(db)
    })
    const before = await readFile(journalDatabaseFile(root))
    const journal = await open()
    expect(journal.isReadOnly).toBe(true)
    await expect(journal.appendItem(item('refused'), body)).rejects.toMatchObject({
      code: 'journal_read_only'
    })
    await journal.close()
    expect(await readFile(journalDatabaseFile(root))).toEqual(before)
    inspect((db) => {
      expect(raw(db)).toEqual(original)
      expect(replayJournal(db, false, identity.sessionId)?.readOnly).toBe(true)
    })
  }
})

it('preserves unsupported binary encoding read-only with exact type and file bytes', async () => {
  inspect((db) => {
    db.prepare('UPDATE journal_rows SET row_json = ? WHERE seq = 6').run(
      Buffer.from([0, 255, 123, 195, 40])
    )
    expect(replayJournal(db, false, identity.sessionId)?.readOnly).toBe(true)
    original = raw(db)
  })
  const before = await readFile(journalDatabaseFile(root))
  const journal = await open()
  expect(journal.isReadOnly).toBe(true)
  await journal.close()
  expect(await readFile(journalDatabaseFile(root))).toEqual(before)
  inspect((db) => expect(raw(db)).toEqual(original))
})

it('replays supported UTF-8 BLOB prefixes and seals their original storage bytes', async () => {
  inspect((db) => {
    db.exec('UPDATE journal_rows SET row_json = CAST(row_json AS BLOB) WHERE seq <= 2')
    original = raw(db)
  })
  const journal = await open()
  expect(journal.isReadOnly).toBe(false)
  expect(journal.snapshot().items.some((entry) => entry.itemId.includes('prefix'))).toBe(true)
  await journal.replaceEpochItems('legacy_import', 2, [{ identity: item('small'), body }])
  await journal.rollEpoch('handle_forked', 3)
  await journal.close()
  await open().then((reopened) => reopened.close())
  inspect((db) => expect(raw(db)).toEqual(original))
})
