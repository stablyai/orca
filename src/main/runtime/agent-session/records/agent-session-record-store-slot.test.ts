/** Early launch admission and the later chat host must share one record-store writer. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { JournalSqlDatabase } from '../../../native-chat/agent-session-journal/database/journal-sql-database'
import { openJournalDatabase } from '../../../native-chat/agent-session-journal/database/journal-database'
import { journalDatabasePath } from '../../../native-chat/agent-session-journal/database/journal-host-database'
import {
  journalDomainDatabasePath,
  openJournalDomainDatabase
} from '../../../native-chat/agent-session-journal/database/journal-domain-database'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from '../../../native-chat/agent-session-journal/journal-sql-worker-bundle.test-fixture'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import {
  closeAgentSessionRecordStoreDatabase,
  hasPersistedStructuredAgentSessionStore,
  openAgentSessionRecordStoreOnce,
  peekOpenedAgentSessionRecordStore,
  retireAgentSessionRecordStore
} from './agent-session-record-store-slot'

const HOST_ID = 'local'
let stateDirectory: string
let closed: Set<JournalSqlDatabase>

function location(directory = stateDirectory) {
  return {
    stateDirectory: directory,
    legacySessionTabIds: [],
    hostId: HOST_ID,
    logger: createStructuredAgentSessionLogger(),
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath(),
    onMaintenanceTick: () => {}
  }
}

const retireStandalone = () =>
  retireAgentSessionRecordStore((opened) =>
    closeAgentSessionRecordStoreDatabase(opened?.journalDatabase)
  )

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'orca-record-store-slot-'))
  closed = new Set()
  const realClose = JournalSqlDatabase.prototype.close
  vi.spyOn(JournalSqlDatabase.prototype, 'close').mockImplementation(function (
    this: JournalSqlDatabase
  ) {
    return realClose.call(this).then(() => {
      closed.add(this)
    })
  })
})

afterEach(async () => {
  await retireStandalone()
  vi.restoreAllMocks()
  await rm(stateDirectory, { recursive: true, force: true })
})

it('discovers saved SQL chats after restart and consults the old store only before conversion', async () => {
  expect(hasPersistedStructuredAgentSessionStore(stateDirectory)).toBe(false)
  const oldPath = journalDatabasePath(stateDirectory)
  const { db: old } = openJournalDatabase(oldPath)
  try {
    old.prepare('INSERT INTO agent_session_records VALUES(?,?)').run('old-chat', '{}')
  } finally {
    old.close()
  }
  expect(hasPersistedStructuredAgentSessionStore(stateDirectory)).toBe(true)
  const { db } = openJournalDomainDatabase(journalDomainDatabasePath(stateDirectory))
  try {
    expect(hasPersistedStructuredAgentSessionStore(stateDirectory)).toBe(false)
    db.prepare('INSERT INTO agent_session_records VALUES(?,?)').run('new-chat', '{}')
  } finally {
    db.close()
  }
  await rm(oldPath)
  expect(hasPersistedStructuredAgentSessionStore(stateDirectory)).toBe(true)
})

it.each(['standalone', 'construction'] as const)(
  'retains failed %s database closure for retry',
  async (path) => {
    const { AgentSessionRecordStore } = await import('./agent-session-record-store')
    let database: JournalSqlDatabase | undefined
    const realOpen = JournalSqlDatabase.open
    vi.spyOn(JournalSqlDatabase, 'open').mockImplementation(async (...args) => {
      database = await realOpen(...args)
      return database
    })
    vi.mocked(JournalSqlDatabase.prototype.close).mockRejectedValueOnce(new Error('close failed'))
    if (path === 'construction') {
      vi.spyOn(AgentSessionRecordStore, 'open').mockImplementationOnce(() => {
        throw new Error('construction failed')
      })
      await expect(openAgentSessionRecordStoreOnce(location())).rejects.toThrow('close failed')
    } else {
      await openAgentSessionRecordStoreOnce(location())
      await expect(retireStandalone()).rejects.toThrow('close failed')
    }
    const retiring = database!
    expect(closed.has(retiring)).toBe(false)
    // A new admission must first finish retiring the old connection.
    const reopened = await openAgentSessionRecordStoreOnce(location())
    expect(closed.has(retiring)).toBe(true)
    expect(reopened.journalDatabase).not.toBe(retiring)
  }
)

it.each(['draining', 'refused'] as const)(
  'keeps the physical writer owned through a %s retirement before launch admission reopens',
  async (path) => {
    const opened = await openAgentSessionRecordStoreOnce(location())
    const realOpen = JournalSqlDatabase.open
    vi.spyOn(JournalSqlDatabase, 'open').mockImplementation((...args) => {
      if (!closed.has(opened.journalDatabase)) {
        throw new Error('second physical journal writer')
      }
      return realOpen(...args)
    })
    const drain = Promise.withResolvers<void>()
    let attempts = 0
    const stopped = retireAgentSessionRecordStore(async (owned) => {
      attempts++
      await drain.promise
      if (path === 'refused' && attempts === 1) {
        throw new Error('sink still owned')
      }
      await closeAgentSessionRecordStoreDatabase(owned?.journalDatabase)
    })
    const observedStop = stopped.catch((error: unknown) => error)
    expect(peekOpenedAgentSessionRecordStore()).toBeNull()
    const replacement = openAgentSessionRecordStoreOnce(location())
    const observedReplacement = replacement.catch((error: unknown) => error)
    await new Promise(setImmediate)
    expect(closed.has(opened.journalDatabase)).toBe(false)
    drain.resolve()
    if (path === 'refused') {
      expect(await observedStop).toEqual(new Error('sink still owned'))
      expect(await observedReplacement).toEqual(new Error('sink still owned'))
      expect(closed.has(opened.journalDatabase)).toBe(false)
      const retried = await openAgentSessionRecordStoreOnce(location())
      expect(closed.has(retried.journalDatabase)).toBe(false)
    } else {
      await stopped
      expect(closed.has((await replacement).journalDatabase)).toBe(false)
    }
    expect(closed.has(opened.journalDatabase)).toBe(true)
  }
)
