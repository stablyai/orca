import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { agentSessionAttachmentStoreRoot } from '../native-chat/agent-session-attachments/agent-session-attachment-references'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import * as attachmentSweeps from '../native-chat/agent-session-attachments/agent-session-attachment-sweep'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import type Database from '../sqlite/sync-database'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import {
  installAgentSessionAttachments,
  stopAgentSessionAttachments
} from './structured-agent-session-attachment-wiring'

let stateDirectory: string

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'orca-attachment-wiring-'))
})

afterEach(async () => {
  stopAgentSessionAttachments()
  vi.useRealTimers()
  vi.restoreAllMocks()
  await closeTestJournalHostDatabases()
  await rm(stateDirectory, { recursive: true, force: true })
})

const records: Pick<AgentSessionRecordStore, 'getRecord' | 'isSessionUnreadable'> = {
  getRecord: () => null,
  isSessionUnreadable: () => false
}

function install(directory = stateDirectory): void {
  // Written by a newer Orca: the sweeps read no claims, so nothing here touches the connection.
  const journal: Parameters<typeof installAgentSessionAttachments>[0]['journalDatabase'] = {
    writeAutocommit: () => {
      throw new Error('not opened in this test')
    },
    transaction: () => {
      throw new Error('not opened in this test')
    },
    readOnly: true,
    isClosed: false,
    get db(): Database.Database {
      throw new Error('not opened in this test')
    }
  }
  installAgentSessionAttachments({
    stateDirectory: directory,
    store: records,
    journalDatabase: journal,
    logger: createStructuredAgentSessionLogger()
  })
}

describe('installAgentSessionAttachments', () => {
  // Claude takes the store as an added directory only if it exists when Claude starts.
  it('creates the store root the Claude launch is granted, before any upload', () => {
    install()
    const root = agentSessionAttachmentStoreRoot(stateDirectory)
    expect(existsSync(root)).toBe(true)
    expect(getAgentSessionAttachmentStore()?.rootDir).toBe(root)
  })

  it('still installs the store when the root cannot be created', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A file where the state directory should be: nothing can be created under it.
    const blocked = join(stateDirectory, 'not-a-directory')
    await writeFile(blocked, '')
    expect(() => install(blocked)).not.toThrow()
    expect(getAgentSessionAttachmentStore()?.rootDir).toBe(agentSessionAttachmentStoreRoot(blocked))
    warn.mockRestore()
  })

  it("starts the chat database's sweep of retired records and stops it with the attachments", async () => {
    vi.useFakeTimers()
    vi.spyOn(attachmentSweeps, 'startAgentSessionAttachmentSweeps').mockReturnValue({
      stop: () => undefined
    })
    const database = openTestJournalHostDatabase(stateDirectory)
    const retire = () =>
      database.transaction((db) => {
        const generation = db
          .prepare('INSERT INTO journal_outcome_generations (session_id, epoch) VALUES (?, ?)')
          .run('gone', 'gone-epoch').lastInsertRowid
        db.prepare(`INSERT INTO journal_outcomes
          (generation, seq, field, entry_key, format, ordinal, value_json, deleted)
          VALUES (?, 1, 'aliases', '"k"', 1, 's0000000000000001:0000000000000000', '["k","v"]', 0)`).run(
          generation
        )
      })
    const retired = () =>
      database.db.prepare('SELECT COUNT(*) AS n FROM journal_outcome_generations').get()?.n
    retire()
    installAgentSessionAttachments({
      stateDirectory,
      store: records,
      journalDatabase: database,
      logger: createStructuredAgentSessionLogger()
    })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(retired()).toBe(1)
    // The first pass a minute after launch: the records page, a rest, then the generation row.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(retired()).toBe(0)
    retire()
    stopAgentSessionAttachments()
    await vi.advanceTimersByTimeAsync(12 * 60 * 60_000)
    expect(retired()).toBe(1)
  })
})
