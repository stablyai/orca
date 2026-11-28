// @orca-isolated-worker -- Suite hooks own the temporary SQL worker bundle.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import type * as Fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
const link = vi.hoisted(() => ({ winner: '' }))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof Fs>()
  return {
    ...fs,
    // Another initializer publishes first, so this one's link meets a real EEXIST.
    linkSync: (existing: Fs.PathLike, created: Fs.PathLike) => {
      if (link.winner && String(created).endsWith('agent-session-domain.db')) {
        fs.writeFileSync(created, '')
      }
      return fs.linkSync(existing, created)
    }
  }
})
import Database from '../../../sqlite/sync-database'
import {
  openJournalDatabase,
  runJournalTransaction
} from '../../../native-chat/agent-session-journal/database/journal-database'
import { initializeJournalDomainDatabaseCustody } from '../../../native-chat/agent-session-journal/database/journal-domain-database'
import {
  journalDatabasePath,
  journalDomainDatabasePath
} from '../../../native-chat/agent-session-journal/database/journal-host-database'
import { JournalSqlDatabase } from '../../../native-chat/agent-session-journal/database/journal-sql-database'
import { publishJournalSessionEpoch } from '../../../native-chat/agent-session-journal/durable-rows/journal-row-table'
import { v1_4_219Journal } from '../../../native-chat/agent-session-journal/journal-legacy-v1-4-219.test-fixture'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from '../../../native-chat/agent-session-journal/journal-sql-worker-bundle.test-fixture'
import {
  AGENT_SESSION_ATTACHMENT_PART_FILE,
  agentSessionAttachmentStoreRoot
} from '../../../native-chat/agent-session-attachments/agent-session-attachment-references'
import { AgentSessionAttachmentStore } from '../../../native-chat/agent-session-attachments/agent-session-attachment-store'
import { sweepAgentSessionAttachments } from '../../../native-chat/agent-session-attachments/agent-session-attachment-sweep'
import { structuredAgentSessionAttachmentSweepFacts } from './structured-agent-session-attachment-sweep'

const OWNED = '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c01'
const ORPHAN = '7c2d9e10-3f4a-4b5c-8d6e-2f1a0b9c8d02'
const PART = '3e1f0a9b-8c7d-4e6f-a5b4-c3d2e1f0a903'
const REFUSED = '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c04'

const roots: string[] = []
afterEach(() => {
  link.winner = ''
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function profile(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-attachment-custody-'))
  roots.push(root)
  return root
}

/** An older Orca's writable open of its own journal. */
function original(root: string, write: (db: Database.Database) => void): void {
  const { db } = openJournalDatabase(journalDatabasePath(root))
  try {
    runJournalTransaction(db, () => write(db))
  } finally {
    db.close()
  }
}

function chat(db: Database.Database, sessionId: string): void {
  publishJournalSessionEpoch(db, { sessionId, workspaceId: 'workspace' }, 'epoch')
  db.prepare('INSERT INTO agent_session_records VALUES(?,?)').run(
    sessionId,
    JSON.stringify({ sessionId, lease: { sessionId } })
  )
  db.prepare('INSERT INTO agent_session_tabs VALUES(?,?,?)').run(`tab-${sessionId}`, sessionId, 0)
}

function claim(db: Database.Database, uploadId: string, sessionId: string): void {
  const insert = db.prepare('INSERT INTO agent_session_attachment_claims VALUES(?,?,?)')
  insert.run(uploadId, sessionId, 1)
}

function upload(root: string, uploadId: string, file = 'shot.png'): void {
  const dir = join(agentSessionAttachmentStoreRoot(root), uploadId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), 'bytes')
  // Far past every sweep age.
  utimesSync(dir, new Date(0), new Date(0))
}

function stored(root: string, uploadId: string): boolean {
  return existsSync(join(agentSessionAttachmentStoreRoot(root), uploadId))
}

/** This build's database while no writer has it open. */
function destination<T>(root: string, read: (db: Database.Database) => T): T {
  const db = new Database(journalDomainDatabasePath(root))
  try {
    return read(db)
  } finally {
    db.close()
  }
}

function claims(root: string): string[] {
  return destination(root, (db) =>
    db
      .prepare('SELECT upload_id FROM agent_session_attachment_claims ORDER BY upload_id')
      .all()
      .map((row) => String(row.upload_id))
  )
}

function marks(root: string): string[] {
  return destination(root, (db) =>
    db
      .prepare('SELECT upload_id FROM agent_session_attachment_sweeps')
      .all()
      .map((row) => String(row.upload_id))
  )
}

/** One writer open of the real SQL worker, then `passes` sweeps against it. */
async function launch(
  root: string,
  passes = 1,
  retained?: () => Promise<ReadonlySet<string> | null>
): Promise<void> {
  const database = await JournalSqlDatabase.open(root, {
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath(),
    onMaintenanceError: () => {}
  })
  try {
    const store = new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(root), {
      hasSession: () => true
    })
    const facts = structuredAgentSessionAttachmentSweepFacts(database, retained)
    for (let pass = 0; pass < passes; pass++) {
      await sweepAgentSessionAttachments(store, facts)
    }
  } finally {
    await database.close()
  }
}

it('touches nothing while the original cannot be read, then cancels a mark its claim reached', async () => {
  const root = profile()
  original(root, (db) => chat(db, 'kept'))
  await launch(root, 0)
  upload(root, OWNED)
  upload(root, ORPHAN)
  upload(root, PART, AGENT_SESSION_ATTACHMENT_PART_FILE)
  // A sweep marked the upload, then the older Orca attached it before the removal ran.
  destination(root, (db) =>
    db.prepare('INSERT INTO agent_session_attachment_sweeps VALUES(?,?)').run(OWNED, 1)
  )
  original(root, (db) => claim(db, OWNED, 'kept'))
  const bytes = readFileSync(journalDatabasePath(root))
  writeFileSync(journalDatabasePath(root), Buffer.alloc(bytes.length, 1))

  await launch(root)
  expect([OWNED, ORPHAN, PART].map((id) => stored(root, id))).toEqual([true, true, true])
  expect(marks(root)).toEqual([OWNED])

  writeFileSync(journalDatabasePath(root), bytes)
  await launch(root)
  expect([OWNED, ORPHAN, PART].map((id) => stored(root, id))).toEqual([true, false, false])
  const owned = join(agentSessionAttachmentStoreRoot(root), OWNED, 'shot.png')
  expect(readFileSync(owned, 'utf8')).toBe('bytes')
  expect(claims(root)).toEqual([OWNED])
  expect(marks(root)).toEqual([])
})

it('keeps a claim it read across sweeps when the rest of that pass failed', async () => {
  const root = profile()
  original(root, (db) => chat(db, 'kept'))
  await launch(root, 0)
  upload(root, OWNED)
  original(root, (db) => {
    chat(db, 'later')
    claim(db, OWNED, 'later')
    // Reading the original's tabs now fails, after its claims were read and before any chat.
    db.exec('ALTER TABLE agent_session_tabs RENAME COLUMN tab_id TO saved_tab_id')
  })

  await launch(root, 2)
  expect(stored(root, OWNED)).toBe(true)
  expect(claims(root)).toEqual([OWNED])
})

it('keeps custody unknown across launches when this file refuses a claim it must keep', async () => {
  const root = profile()
  original(root, (db) => chat(db, 'kept'))
  await launch(root, 0)
  upload(root, OWNED)
  upload(root, REFUSED)
  destination(root, (db) =>
    db.exec(`CREATE TRIGGER refuse_claim BEFORE INSERT ON agent_session_attachment_claims
      WHEN NEW.upload_id='${REFUSED}' BEGIN SELECT RAISE(ABORT, 'refused'); END`)
  )
  // A chat this file has never shown, so its refused claims also refuse joining it here.
  original(root, (db) => {
    chat(db, 'joining')
    claim(db, OWNED, 'joining')
    claim(db, REFUSED, 'joining')
  })

  await launch(root)
  await launch(root)
  expect(claims(root)).toEqual([OWNED])
  expect(stored(root, REFUSED)).toBe(true)
})

it('takes a v1.4.219 journal as holding no claims, but not a newer one whose claims table is gone', async () => {
  const historical = profile()
  v1_4_219Journal(journalDatabasePath(historical), 'chat', false)
  upload(historical, ORPHAN)
  await launch(historical)
  expect(stored(historical, ORPHAN)).toBe(false)

  const dropped = profile()
  original(dropped, (db) => {
    chat(db, 'kept')
    db.exec('DROP TABLE agent_session_attachment_claims')
  })
  upload(dropped, ORPHAN)
  await launch(dropped)
  expect(stored(dropped, ORPHAN)).toBe(true)
})

it('holds an upload the older Orca claimed after this open reconciled', async () => {
  const root = profile()
  original(root, (db) => chat(db, 'kept'))
  upload(root, OWNED)
  const database = await JournalSqlDatabase.open(root, {
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath(),
    onMaintenanceError: () => {}
  })
  try {
    original(root, (db) => claim(db, OWNED, 'kept'))
    await sweepAgentSessionAttachments(
      new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(root), {
        hasSession: () => true
      }),
      structuredAgentSessionAttachmentSweepFacts(database)
    )
  } finally {
    await database.close()
  }
  expect(stored(root, OWNED)).toBe(true)
})

it('takes neither a missing original with a companion nor a lost initializer race as absent', async () => {
  const companion = profile()
  writeFileSync(`${journalDatabasePath(companion)}-wal`, 'frames')
  upload(companion, ORPHAN)
  await launch(companion)
  expect(stored(companion, ORPHAN)).toBe(true)

  const raced = profile()
  link.winner = 'other'
  expect((await initializeJournalDomainDatabaseCustody(raced)).custody).toEqual({ kind: 'unknown' })
})

it('holds every removal in a pass whose item mail retention could not be read', async () => {
  const root = profile()
  await launch(root, 0)
  upload(root, ORPHAN)
  upload(root, OWNED)
  destination(root, (db) =>
    db.prepare('INSERT INTO agent_session_attachment_sweeps VALUES(?,?)').run(ORPHAN, 1)
  )

  // A store that answers on a later read does not release this pass's hold.
  const answers: (ReadonlySet<string> | null)[] = [null]
  await launch(root, 1, async () => answers.shift() ?? new Set())
  expect([ORPHAN, OWNED].map((id) => stored(root, id))).toEqual([true, true])
  expect(marks(root)).toEqual([ORPHAN])

  await launch(root, 1, async () => new Set())
  expect(stored(root, ORPHAN)).toBe(false)
})
