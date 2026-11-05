import {
  seedLegacyTestJournal,
  pinTestJournalInputMode
} from './journal-native-fixture-test-support'
export {
  seedLegacyTestJournal,
  appendTestJournalQueueRow,
  finishTestJournalHistoricalInputs,
  pinTestJournalInputMode,
  publishTestJournalEpoch,
  readTestJournalRows,
  liveTestJournalRows,
  insertTestJournalRow,
  insertTestJournalRowJson,
  updateTestJournalRowJson,
  deleteTestJournalRow,
  writeTestLegacyTerminalGaps,
  readTestJournalOutcomes,
  readTestQueueChanges
} from './journal-native-fixture-test-support'
import { journalNativeTestInstrumentation } from './journal-native-test-instrumentation'

// Share one connection per test profile to match production host ownership.

import { resolve } from 'node:path'
import { afterAll, beforeEach, vi } from 'vitest'
import * as workerThreads from '../../worker-threads/worker-thread-spawn'
import NativeDatabase from '../../sqlite/sync-database'
import { journalDatabasePath, JournalHostDatabase } from './journal-host-database'
import { runJournalTransaction } from './journal-database'

import { restoreJournal, type JournalLoad } from './journal-open'

import type { AgentSessionJournal } from './journal-store'
import type { AgentSessionJournalOptions } from './journal-store-contracts'
// Share one connection per test profile to match production host ownership.

import type Database from '../../sqlite/sync-database'

export type TestJournalHostDatabase = JournalHostDatabase & {
  /** Explicit native fixture access for seeding old/corrupt bytes and checking saved data. */
  db: Database.Database
  fixtureTransaction: <T>(run: (db: Database.Database) => T) => T
}
const nativeFixtures = new Map<JournalHostDatabase, Database.Database>()
export function testJournalNativeDatabase(database: JournalHostDatabase): Database.Database {
  const fixture = nativeFixtures.get(database)
  if (fixture) {
    return fixture
  }
  const db = new NativeDatabase(journalDatabasePath(database.stateDirectory), {
    readonly: database.readOnly
  })
  nativeFixtures.set(database, db)
  const close = database.close.bind(database)
  database.close = async () => {
    await close()
    if (nativeFixtures.delete(database)) {
      db.close()
    }
  }
  return db
}

const opened = new Map<string, TestJournalHostDatabase>()
const opening = new Map<string, Promise<TestJournalHostDatabase>>()
const spawnWorker = workerThreads.spawnWorkerThread

function prepareTestWorker(): void {
  const instrumentation = `import { createRequire } from 'node:module';
    const require = createRequire(process.cwd() + '/journal-fixture.cjs');
    ${journalNativeTestInstrumentation}`
  vi.spyOn(workerThreads, 'spawnWorkerThread').mockImplementation((entry, options) =>
    spawnWorker(entry, {
      ...options,
      execArgv: ['--import', `data:text/javascript,${encodeURIComponent(instrumentation)}`]
    })
  )
}

beforeEach(prepareTestWorker)
afterAll(closeTestJournalHostDatabases)

export async function openTestJournalHostDatabase(
  stateDirectory: string
): Promise<TestJournalHostDatabase> {
  const directory = resolve(stateDirectory)
  const existing = opened.get(directory)
  if (existing && !existing.isClosed) {
    return existing
  }
  const pending = opening.get(directory)
  if (pending) {
    return pending
  }
  const task = (async () => {
    prepareTestWorker()
    const database = await JournalHostDatabase.open(directory)
    const db = testJournalNativeDatabase(database)
    const fixture = Object.assign(database, {
      db,
      fixtureTransaction: <T>(run: (db: Database.Database) => T): T =>
        runJournalTransaction(db, run)
    })
    opened.set(directory, fixture)
    return fixture
  })()
  opening.set(directory, task)
  try {
    return await task
  } finally {
    opening.delete(directory)
  }
}

export async function closeTestJournalHostDatabase(stateDirectory: string): Promise<void> {
  const directory = resolve(stateDirectory)
  await opening.get(directory)
  await opened.get(directory)?.close()
  opened.delete(directory)
}

export async function closeTestJournalHostDatabases(): Promise<void> {
  await Promise.all(opening.values())
  for (const database of opened.values()) {
    await database.close()
  }
  opened.clear()
}

export type TestJournalOptions = Omit<AgentSessionJournalOptions, 'database'> & {
  stateDirectory: string
}

export type TrackedJournalOpener = {
  open: (options: TestJournalOptions) => Promise<AgentSessionJournal>
  track: <T extends AgentSessionJournal>(journal: T) => T
  closeAll: () => Promise<void>
}

export function createTrackedJournalOpener(
  fixture: { legacyInputs?: boolean } = {}
): TrackedJournalOpener {
  const journals: AgentSessionJournal[] = []
  return {
    open: async ({ stateDirectory, ...options }) => {
      if (fixture.legacyInputs) {
        seedLegacyTestJournal(await openTestJournalHostDatabase(stateDirectory), options)
      }
      const { openAgentSessionJournal } = await import('./journal-store-factory')
      const journal = await openAgentSessionJournal({
        ...options,
        database: await openTestJournalHostDatabase(stateDirectory)
      })
      if (fixture.legacyInputs) {
        pinTestJournalInputMode(journal)
      }
      journals.push(journal)
      return journal
    },
    track: (journal) => {
      journals.push(journal)
      return journal
    },
    closeAll: async () => {
      await Promise.allSettled(journals.splice(0).map((journal) => journal.close()))
      await closeTestJournalHostDatabases()
    }
  }
}

export const SAVED_BY_NEWER_ORCA = {
  refusal: {
    code: 'agent_session_journal_unreadable',
    details: { reason: 'journalWrittenByNewerOrca' }
  }
}

export function loadTestJournal(stateDirectory: string, sessionId: string): JournalLoad | null {
  return restoreJournal(requireTestDatabase(stateDirectory).db, sessionId)
}

export function getTestJournalNativeDatabase(stateDirectory: string): Database.Database {
  return requireTestDatabase(stateDirectory).db
}

function requireTestDatabase(stateDirectory: string): TestJournalHostDatabase {
  const database = opened.get(resolve(stateDirectory))
  if (!database || database.isClosed) {
    throw new Error('open the async journal fixture before reading it')
  }
  return database
}
