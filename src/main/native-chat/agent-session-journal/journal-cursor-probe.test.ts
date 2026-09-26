import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { probeJournalCursor } from './journal-cursor-probe'
import { journalDatabaseFile } from './journal-paths'
import { openAgentSessionJournal } from './journal-store-factory'

const SESSION = 'session-alpha'
let dirs: string[] = []

afterEach(() => {
  dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true }))
  dirs = []
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-journal-probe-'))
  dirs.push(dir)
  return dir
}

/** A closed, checkpointed journal holding one message, and the position its open computes. */
async function settledJournal(journalDir: string) {
  const journal = await openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'thread-1' }
    },
    journalDir
  })
  await journal.appendItem(
    { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
    { fence: 1 }
  )
  const cursor = journal.cursor()
  await journal.close()
  return cursor
}

describe('journal cursor probe', () => {
  it('reads the position the open computes and leaves the database file byte-identical (C13)', async () => {
    const journalDir = tempDir()
    const cursor = await settledJournal(journalDir)
    const dbPath = journalDatabaseFile(journalDir)
    const before = readFileSync(dbPath)

    expect(probeJournalCursor(journalDir, SESSION)).toEqual(cursor)

    expect(readFileSync(dbPath).equals(before)).toBe(true)
    if (process.platform !== 'win32') {
      // A read-only open of a WAL file may leave sidecars behind; they stay owner-only.
      for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`].filter((path) => existsSync(path))) {
        expect(statSync(sidecar).mode & 0o777).toBe(0o600)
      }
    }
  })

  it('reads a turn a crash left only in the write-ahead log (C15)', async () => {
    const journalDir = tempDir()
    const settled = await settledJournal(journalDir)
    const dbPath = journalDatabaseFile(journalDir)
    // A later turn commits into the WAL, and the process dies before any checkpoint.
    const writer = new Database(dbPath)
    writer.pragma('wal_autocheckpoint = 0')
    writer.exec('BEGIN IMMEDIATE')
    const insert = writer.prepare(
      'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
    )
    for (let offset = 1; offset <= 5; offset += 1) {
      insert.run(SESSION, settled.epoch, settled.sequence + offset, 1, '{}')
    }
    writer.exec('COMMIT')
    const crashed = join(tempDir(), 'journal')
    mkdirSync(crashed)
    copyFileSync(dbPath, journalDatabaseFile(crashed))
    copyFileSync(`${dbPath}-wal`, `${journalDatabaseFile(crashed)}-wal`)
    writer.close()

    expect(probeJournalCursor(crashed, SESSION)).toEqual({
      epoch: settled.epoch,
      sequence: settled.sequence + 5
    })
  })

  it('misses, rather than throws, on a file that is not a database', () => {
    const journalDir = tempDir()
    mkdirSync(journalDir, { recursive: true })
    const dbPath = journalDatabaseFile(journalDir)
    rmSync(dbPath, { force: true })
    expect(probeJournalCursor(journalDir, SESSION)).toBeNull()
    writeFileSync(dbPath, Buffer.alloc(8192, 7))
    expect(probeJournalCursor(journalDir, SESSION)).toBeNull()
  })
})
