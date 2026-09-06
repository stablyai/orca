// Every path that can open a SQLite connection releases it.
//
// Asserting that the happy path closes cleanly proves nothing: these sites are
// reached only when something has already gone wrong. On POSIX a leak is
// SILENT — the unlink succeeds — so each case asserts BOTH that the sidecars
// are gone and that the directory renames and removes, which is the half that
// actually fails on Windows.

import { access, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import Database from '../../sqlite/sync-database'
import { openJournalDatabase } from './journal-database'
import { JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'
import { loadJournal } from './journal-open'
import { journalDatabaseFile } from './journal-paths'
import { createTrackedJournalOpener } from './journal-store-test-open'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let base: string
let root: string
const journals = createTrackedJournalOpener()

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function runningTool(): AgentJournalItemBody {
  return { kind: 'tool-call', name: 'command', input: {}, state: 'running' }
}

async function exists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false)
}

/** The platform-independent proof: an open handle blocks both of these on
 *  Windows, where every leak in this file actually shows up. */
async function expectNothingHoldsTheDirectory(): Promise<void> {
  const dbPath = journalDatabaseFile(root)
  expect(await exists(`${dbPath}-wal`)).toBe(false)
  expect(await exists(`${dbPath}-shm`)).toBe(false)
  const moved = `${root}-recovered-vtest`
  await rename(root, moved)
  await rm(moved, { recursive: true })
  root = join(base, `journal-${Math.random().toString(36).slice(2)}`)
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'orca-journal-handles-'))
  root = join(base, 'journal')
})

afterEach(async () => {
  await journals.closeAll()
  await rm(base, { recursive: true, force: true })
})

describe('the standalone probe owns its own connection', () => {
  it('leaves no handle behind after fifty repeated loads', async () => {
    const journal = await journals.open({ identity: IDENTITY, journalDir: root })
    await journal.appendItem(item(1), { kind: 'message', role: 'user', blocks: [] }, { fence: 1 })
    await journal.close()

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const loaded = await loadJournal(root, IDENTITY.sessionId)
      expect(loaded?.readOnly).toBe(false)
    }
    await expectNothingHoldsTheDirectory()
  })

  it('leaves no handle behind after fifty loads of a latched future schema', async () => {
    const journal = await journals.open({ identity: IDENTITY, journalDir: root })
    await journal.close()
    const seeded = openJournalDatabase(journalDatabaseFile(root))
    seeded.db.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION + 3}`)
    seeded.db.close()

    for (let attempt = 0; attempt < 50; attempt += 1) {
      // The latched open closes the probe connection and returns the read-only
      // reopen, so probing repeatedly leaves nothing on a file we must not touch.
      expect((await loadJournal(root, IDENTITY.sessionId))?.readOnly).toBe(true)
    }
    // A read-only connection cannot remove the sidecars it materialized, so only
    // the rename/remove half is expected to hold here.
    const moved = `${root}-recovered-vtest`
    await rename(root, moved)
    await rm(moved, { recursive: true })
    root = join(base, 'journal-after-latched')
  })

  it('returns null for a session with no journal, without creating one', async () => {
    expect(await loadJournal(root, IDENTITY.sessionId)).toBeNull()
    expect(await exists(journalDatabaseFile(root))).toBe(false)
  })
})

describe('failure paths inside the open call', () => {
  // Site 1: the raw connection is owned by `openJournalDatabase` until it returns.
  it('closes the raw connection when the version read cannot run', async () => {
    await journals.open({ identity: IDENTITY, journalDir: root }).then((journal) => journal.close())
    await writeFile(journalDatabaseFile(root), 'this is not a database', 'utf8')

    expect(() => openJournalDatabase(journalDatabaseFile(root))).toThrow()
    await expectNothingHoldsTheDirectory()
  })

  it('closes the raw connection when the migration cannot start', async () => {
    const journal = await journals.open({ identity: IDENTITY, journalDir: root })
    await journal.close()
    const blocker = openJournalDatabase(journalDatabaseFile(root))
    // Roll the stored version back so the migration runs, then hold the write
    // lock it needs: the throw lands after the connection already exists.
    blocker.db.pragma('user_version = 0')
    blocker.db.exec('BEGIN IMMEDIATE')
    blocker.db.exec("INSERT INTO journal_sessions VALUES ('other', 'e', 1)")
    try {
      expect(() => openJournalDatabase(journalDatabaseFile(root))).toThrow()
    } finally {
      blocker.db.exec('ROLLBACK')
      blocker.db.close()
    }
    await expectNothingHoldsTheDirectory()
  }, 60_000)

  // Sites 2 and 3: `open()` closes its own connection on any throw after the
  // connection exists, which is what lets the factory need no `finally`.
  it('leaves nothing open when a post-connection step of open() throws', async () => {
    const journal = await journals.open({ identity: IDENTITY, journalDir: root })
    await journal.appendItem(item(1), runningTool(), { fence: 1 })
    await journal.close()

    // Replay runs after the connection is open, so a read it cannot serve
    // throws with the handle already held.
    const exec = vi.spyOn(Database.prototype, 'prepare').mockImplementation(() => {
      throw new Error('replay cannot read this journal')
    })
    try {
      await expect(journals.open({ identity: IDENTITY, journalDir: root })).rejects.toThrow(
        'replay cannot read this journal'
      )
    } finally {
      exec.mockRestore()
    }
    await expectNothingHoldsTheDirectory()
  })
})
