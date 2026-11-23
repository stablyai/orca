import { expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { journalDomainImportState } from './journal-domain-import-rows'
import { initializeJournalDomainDatabase } from './database/journal-domain-database'
import {
  companions,
  fakeLease,
  olderOrcaChat,
  profile,
  queue
} from './journal-legacy-retirement.test-fixture'
import { v1_4_219Journal } from './journal-legacy-v1-4-219.test-fixture'
import { readJournalLegacySourceReceipt } from './database/journal-legacy-source-receipt'
import { legacyDestinationMain } from './journal-legacy-retirement-files'
import { journalDomainDatabasePath } from './database/journal-host-database'

// Journals carrying shapes earlier builds left behind: v1.4.219's queued_message_pauses table and
// the hourly builds' queued_messages.source_json column.

const savedRetirement = (db: Database.Database) =>
  JSON.parse(
    String(
      db
        .prepare(
          "SELECT value FROM agent_session_store_meta WHERE key='journal.legacy-retirement.v2'"
        )
        .get()?.value ?? 'null'
    )
  )

it('retires a journal v1.4.219 wrote, with or without its Stop pauses, upgraded or not', async () => {
  const shapes = [
    (filename: string) => v1_4_219Journal(filename, 'unopened', false),
    // As Stop left it: a pause and the cards still waiting.
    (filename: string) => {
      v1_4_219Journal(filename, 'unopened', true)
      queue(filename, 'unopened', 'queued before Stop in v1.4.219')
    },
    // A later build's writable open upgrades the rest of the file, never the pause table.
    (filename: string) => {
      v1_4_219Journal(filename, 'unopened', true)
      olderOrcaChat(filename, 'continued-later')
    }
  ]
  for (const original of shapes) {
    const older = await profile({ original })
    await older.launch().run()
    expect(older.errors).toEqual([])
    expect(companions(older.filename)).toEqual([])
    expect(journalDomainImportState(older.db, 'unopened').state).toBe('ready')
  }
})

it('keeps a journal whose pause table is not the one v1.4.219 created, or a table no build named', async () => {
  const reshaped = [
    'ALTER TABLE queued_message_pauses ADD COLUMN body_json TEXT',
    'ALTER TABLE queued_message_pauses ADD COLUMN body_json TEXT GENERATED ALWAYS AS (reason) VIRTUAL',
    'CREATE TABLE "constructor" (value TEXT)',
    // An accepted import marker's extra column would go unread.
    'ALTER TABLE journal_imports ADD COLUMN payload_json TEXT',
    'ALTER TABLE queued_message_pauses DROP COLUMN recorded_at',
    // The retired column belongs to the queue only.
    'ALTER TABLE journal_rows ADD COLUMN source_json TEXT'
  ]
  for (const change of reshaped) {
    const older = await profile({
      original: (filename) => {
        v1_4_219Journal(filename, 'unopened', true)
        const db = new Database(filename)
        db.exec(change)
        db.close()
      }
    })
    await older.launch().run()
    expect(companions(older.filename)).toContain(older.filename)
    expect(savedRetirement(older.db)).toMatchObject({
      phase: 'refused',
      reason: 'source-inventory'
    })
  }
})

it('retires a journal with the queue sender column, counting it against what a kept original holds', async () => {
  const withSender = (sender: string) => async () => {
    const older = await profile({
      seed: (legacy) => legacy.exec('ALTER TABLE queued_messages ADD COLUMN source_json TEXT')
    })
    queue(older.filename, 'unopened', 'queued by an hourly build')
    const legacy = new Database(older.filename)
    legacy.prepare('UPDATE queued_messages SET source_json=?').run(sender)
    legacy.close()
    await initializeJournalDomainDatabase(older.root)
    return older
  }
  const small = await withSender('{"v":1,"kind":"agent"}')()
  await small.launch().run()
  expect(small.errors).toEqual([])
  expect(companions(small.filename)).toEqual([])

  // Deleted here, so its waiting card would be kept as the original's version, sender and all.
  const large = await withSender('x'.repeat(3 * 1024 * 1024))()
  large.db.exec("DELETE FROM agent_session_records WHERE session_id='unopened'")
  large.db.exec("DELETE FROM journal_chat_state WHERE session_id='unopened'")
  await large.launch().run()
  expect(companions(large.filename)).toContain(large.filename)
  expect(savedRetirement(large.db)).toMatchObject({ phase: 'refused', reason: 'source-oversize' })
})

it('proves once more an inventory refusal saved before historical shapes were accepted', async () => {
  const refusedAs = async (refusal: Record<string, unknown>) => {
    // The journal those builds refused: v1.4.219's, with a pause and a card waiting.
    const refused = await profile({
      original: (filename) => {
        v1_4_219Journal(filename, 'unopened', true)
        queue(filename, 'unopened', 'queued before Stop in v1.4.219')
      }
    })
    const proof = JSON.stringify(await readJournalLegacySourceReceipt(refused.filename))
    const store = await legacyDestinationMain(journalDomainDatabasePath(refused.root))
    refused.db
      .prepare('INSERT OR REPLACE INTO agent_session_store_meta(key,value) VALUES(?,?)')
      .run(
        'journal.legacy-retirement.v2',
        JSON.stringify({ version: 2, phase: 'refused', policy: 3, proof, store, ...refusal })
      )
    return refused
  }
  // As builds before this one saved them.
  for (const reason of ['source-inventory', 'source-recovery']) {
    const earlier = await refusedAs({ reason })
    await earlier.launch().run()
    expect(earlier.errors).toEqual([])
    expect(companions(earlier.filename)).toEqual([])
  }
  // Saved under this inventory check, or for content: honoured without a proof.
  for (const refusal of [
    { reason: 'source-inventory', inventory: 2 },
    // A later build's own inventory check refused it.
    { reason: 'source-inventory', inventory: 3 },
    { reason: 'source-oversize' }
  ]) {
    const kept = await refusedAs(refusal)
    const legacyProof = vi.spyOn(kept.readers, 'legacyProof')
    await kept.launch().run()
    expect(legacyProof).not.toHaveBeenCalled()
    expect(companions(kept.filename)).toContain(kept.filename)
  }
})

it('saves a refusal older builds honour too', async () => {
  const unknown = await profile({
    seed: (legacy) => legacy.exec('CREATE TABLE written_by_a_newer_build (value TEXT)')
  })
  await unknown.launch().run()
  expect(savedRetirement(unknown.db)).toMatchObject({
    phase: 'refused',
    policy: 3,
    reason: 'source-inventory',
    inventory: 2
  })
  const legacyProof = vi.spyOn(unknown.readers, 'legacyProof')
  await unknown.launch().run()
  expect(legacyProof).not.toHaveBeenCalled()
  expect(companions(unknown.filename)).toContain(unknown.filename)
})

it('saves progress and deletion of a journal with a historical shape under a layout earlier builds reject', async () => {
  // Earlier builds check inventory on the first page only: resuming this proof, they'd skip it.
  const many = await profile({
    original: (filename) => v1_4_219Journal(filename, 'unopened', true),
    seed: (legacy) => {
      const insert = legacy.prepare('INSERT INTO agent_session_records VALUES(?,?)')
      for (let draft = 0; draft < 600; draft++) {
        const id = `draft-${String(draft).padStart(3, '0')}`
        insert.run(id, JSON.stringify({ sessionId: id }))
      }
    }
  })
  const read = many.readers.legacyProof
  const cursors: Parameters<typeof read>[0][] = []
  let stopAfter = 17
  many.readers.legacyProof = async (cursor) => {
    cursors.push(cursor)
    if (cursors.length > stopAfter) {
      throw new Error('Orca quit')
    }
    return read(cursor)
  }
  await many.launch().run()
  expect(savedRetirement(many.db)).toMatchObject({ phase: 'proving', layout: 2 })

  // This build resumes it, and a deletion that doesn't go through is saved the same way.
  cursors.length = 0
  stopAfter = Number.POSITIVE_INFINITY
  const failing = async (filename: string) => ({
    ...(await fakeLease(filename)),
    retire: async () => false
  })
  await many.launch('1.0.1', true, failing).run()
  expect(cursors[0]!.after).not.toBeNull()
  expect(savedRetirement(many.db)).toMatchObject({ phase: 'retiring', layout: 2 })
  cursors.length = 0
  await many.launch().run()
  expect(cursors[0]).toMatchObject({ table: 7, after: null, check: true })
  expect(companions(many.filename)).toEqual([])

  // A journal earlier builds accept keeps the layout they resume.
  const plain = await profile()
  await plain.launch('1.0.1', true, failing).run()
  expect(savedRetirement(plain.db)).toMatchObject({ phase: 'retiring', layout: 1 })
})

it("checks inventory again when it resumes an earlier build's progress", async () => {
  // v1.4.265–267 had no column check on journal_imports, so they could save progress past it.
  const looser = await profile({
    seed: (legacy) => legacy.exec('ALTER TABLE journal_imports ADD COLUMN payload_json TEXT')
  })
  const proof = JSON.stringify(await readJournalLegacySourceReceipt(looser.filename))
  const store = await legacyDestinationMain(journalDomainDatabasePath(looser.root))
  looser.db.prepare('INSERT OR REPLACE INTO agent_session_store_meta(key,value) VALUES(?,?)').run(
    'journal.legacy-retirement.v2',
    JSON.stringify({
      version: 2,
      phase: 'proving',
      layout: 1,
      proof,
      store,
      cursor: { table: 1, after: null }
    })
  )
  await looser.launch().run()
  expect(savedRetirement(looser.db)).toMatchObject({ phase: 'refused', reason: 'source-inventory' })
})

it('holds a proven journal with a historical shape under layout 2 and reads that hold on the next launch', async () => {
  const kept = await profile({
    original: (filename) => v1_4_219Journal(filename, 'unopened', true)
  })
  const keeps = () => kept.launch('1.0.1', true, undefined, undefined, false)
  await keeps().run()
  expect(kept.errors).toEqual([])
  expect(companions(kept.filename)).toContain(kept.filename)
  expect(savedRetirement(kept.db)).toMatchObject({ phase: 'held', layout: 2 })
  const legacyProof = vi.spyOn(kept.readers, 'legacyProof')
  await keeps().run()
  expect(legacyProof).not.toHaveBeenCalled()
})
