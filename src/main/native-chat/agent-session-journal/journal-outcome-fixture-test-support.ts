import { fields } from './journal-state-schema'
import { journalOutcomeSource } from './journal-outcome-format'
import { decodeJournalOutcome, type JournalOutcome } from './journal-outcome-codec'
import type { TestJournalReader } from './journal-row-fixture-test-support'
import type { JournalReadConnection } from './journal-sql-owner'
import type Database from '../../sqlite/sync-database'
import { JournalHostDatabase } from './journal-host-database'
import { mutateTestJournalFixture as mutateFixture } from './journal-drained-fixture-test-support'

export async function setTestUnknownOutcome(
  database: JournalHostDatabase,
  mode: 'format' | 'collection' | 'scalar' | 'old-native' | 'epoch'
): Promise<void> {
  await mutateFixture(database, (db) => {
    if (mode === 'format') {
      db.prepare('UPDATE journal_outcomes SET format = ? WHERE seq = 40').run(3)
    } else if (mode === 'epoch') {
      db.prepare('UPDATE journal_outcome_epochs SET format = ?').run(3)
    } else if (mode === 'collection') {
      db.prepare(
        "UPDATE journal_outcomes SET field = 'futureCollection' WHERE seq = 40 AND field = 'items'"
      ).run()
    } else if (mode === 'old-native') {
      db.prepare(
        "UPDATE journal_outcomes SET format = 1, field = 'inputEntries' WHERE seq = 40 AND field = 'items'"
      ).run()
    } else {
      db.prepare(
        `UPDATE journal_outcomes SET field = '$', entry_key = '"futureScalar"' WHERE seq = 40 AND field = 'items'`
      ).run()
    }
  })
}

export async function setTestInputEntryOrdinal(
  database: JournalHostDatabase,
  key: string,
  ordinal: string
): Promise<void> {
  await mutateFixture(database, (db) => {
    db.prepare(
      "UPDATE journal_outcomes SET ordinal = ? WHERE field = 'inputEntries' AND entry_key = ?"
    ).run(ordinal, JSON.stringify(key))
  })
}

export async function retireTestOutcomeGeneration(
  database: JournalHostDatabase,
  sessionId: string,
  epoch: string
): Promise<void> {
  await mutateFixture(database, (db) => {
    const generation = Number(
      db
        .prepare('INSERT INTO journal_outcome_generations (session_id, epoch) VALUES (?, ?)')
        .run(sessionId, epoch).lastInsertRowid
    )
    db.prepare('UPDATE journal_outcome_epochs SET generation = ? WHERE session_id = ?').run(
      generation,
      sessionId
    )
  })
}

export async function seedTestOutcomeSweepPopulation(
  database: JournalHostDatabase,
  chats: number,
  epoch: string,
  keys = 100
): Promise<void> {
  await mutateFixture(database, (db) => {
    const generation = db.prepare(
      'INSERT INTO journal_outcome_generations (session_id, epoch) VALUES (?, ?)'
    )
    const live = db.prepare('INSERT INTO journal_outcome_epochs VALUES (?, ?, ?, 1, 1, 0)')
    for (let index = 0; index < chats; index++) {
      const id = Number(generation.run(`chat-${index}`, epoch).lastInsertRowid)
      live.run(`chat-${index}`, epoch, id)
    }
    const retired = Number(generation.run('gone', 'gone-epoch').lastInsertRowid)
    const insert = db.prepare(
      `INSERT INTO journal_outcomes (generation, seq, field, entry_key, format, ordinal, value_json, deleted) VALUES (?, 1, 'aliases', ?, 1, 's0000000000000001:0000000000000000', ?, 0)`
    )
    for (let index = 0; index < keys; index++) {
      insert.run(retired, JSON.stringify(`k${index}`), JSON.stringify([`k${index}`, 'v']))
    }
  })
}

export async function setTestOrdinaryOutcomeFormat(database: JournalHostDatabase): Promise<void> {
  await mutateFixture(database, (db) => {
    db.prepare(
      "UPDATE journal_outcomes SET format = 1 WHERE field NOT IN ('inputEntries', 'inputCards')"
    ).run()
  })
}

export async function appendTestItemOutcome(
  database: JournalHostDatabase,
  sessionId: string,
  itemId: string,
  json: string
): Promise<void> {
  await mutateFixture(database, (db) => {
    const source = db
      .prepare('SELECT generation, through_seq FROM journal_outcome_epochs WHERE session_id = ?')
      .get(sessionId)
    if (!source) {
      throw new Error('Missing outcome fixture source')
    }
    const next = Number(source.through_seq) + 1
    const ordinal = `s${String(next).padStart(16, '0')}:0000000000000000`
    db.prepare(`INSERT INTO journal_outcomes (generation, seq, field, entry_key, format, ordinal, value_json, deleted)
      VALUES (?, ?, 'items', ?, 1, ?, ?, 0)`).run(
      source.generation,
      next,
      JSON.stringify(itemId),
      ordinal,
      json
    )
    db.prepare('UPDATE journal_outcome_epochs SET through_seq = ? WHERE session_id = ?').run(
      next,
      sessionId
    )
  })
}

async function readFixture<T>(
  db: TestJournalReader,
  run: (read: Database.Database | JournalReadConnection) => Promise<T>
): Promise<T> {
  return db instanceof JournalHostDatabase ? db.read(run) : run(db)
}

/** Read current canonical contributions in commit order for persisted-outcome assertions. */
export async function readTestJournalOutcomes(
  db: TestJournalReader,
  sessionId: string
): Promise<JournalOutcome[]> {
  return readFixture(db, async (read) => {
    const epoch = (
      await read.prepare('SELECT epoch FROM journal_sessions WHERE session_id = ?').get(sessionId)
    )?.epoch
    if (typeof epoch !== 'string') {
      return []
    }
    const source =
      'pages' in read
        ? await read.source(sessionId, epoch)
        : journalOutcomeSource(read, sessionId, epoch)
    if (!source) {
      return []
    }
    return (
      await read
        .prepare(
          `SELECT seq, field, entry_key, format, ordinal, value_json, deleted FROM journal_outcomes WHERE generation = ? ORDER BY seq, field, entry_key`
        )
        .all(source.generation)
    ).map(decodeJournalOutcome)
  })
}

export async function readTestQueueChanges(
  db: TestJournalReader,
  sessionId: string
): Promise<
  {
    messageId: string
    op: string
    returned: boolean
  }[]
> {
  const seen = new Set<string>()
  return (await readTestJournalOutcomes(db, sessionId)).flatMap((value) => {
    if (value.field !== 'queue.cards') {
      return []
    }
    if (value.deleted) {
      return [{ messageId: String(JSON.parse(value.key)), op: 'withdrawn', returned: false }]
    }
    const [messageId, card] = fields.queue.shape.cards.element.parse(JSON.parse(value.json))
    const first = !seen.has(messageId)
    seen.add(messageId)
    return [
      { messageId, op: first ? 'queued' : card.state, returned: first && card.state === 'returned' }
    ]
  })
}

export async function setTestStoredSenderAgent(
  database: JournalHostDatabase,
  agent: string | number | undefined
): Promise<number> {
  return mutateFixture(database, (db) => {
    const records = db
      .prepare(
        "SELECT generation, seq, ordinal, value_json FROM journal_outcomes WHERE field IN ('items', 'queue.cards')"
      )
      .all()
    const update = db.prepare(
      'UPDATE journal_outcomes SET value_json = ? WHERE generation = ? AND seq = ? AND ordinal = ?'
    )
    for (const row of records) {
      const json = JSON.stringify(JSON.parse(String(row.value_json)), (key, value) =>
        key === 'agent' ? agent : value
      )
      update.run(json, Number(row.generation), Number(row.seq), String(row.ordinal))
    }
    return records.length
  })
}
