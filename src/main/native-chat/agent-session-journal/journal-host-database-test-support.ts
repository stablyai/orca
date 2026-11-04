import { pinTestJournalInputMode } from './journal-historical-inputs.test-support'
export {
  pinTestJournalInputMode,
  finishTestJournalHistoricalInputs
} from './journal-historical-inputs.test-support'
// Share the actual asynchronous owner per test profile; native fixtures never hold a second handle.
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { build } from 'esbuild'
import { afterAll, beforeEach, vi } from 'vitest'
import { journalNativeTestInstrumentation } from './journal-native-test-instrumentation'
import { journalRowSchemaVersion } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { JournalHostDatabase } from './journal-host-database'
import { restoreJournalAsync } from './journal-async-open'
import type { JournalLoad } from './journal-open'
import {
  insertTestJournalRow,
  publishTestJournalEpoch
} from './journal-native-fixture-test-support'
import type { AgentSessionJournal } from './journal-store'
import type { AgentSessionJournalOptions } from './journal-store-contracts'
export * from './journal-native-fixture-test-support'

const opened = new Map<string, JournalHostDatabase>()
const opening = new Map<string, Promise<JournalHostDatabase>>()
let workerBundle: Promise<string> | undefined
let bundleRoot: string | undefined

function prepareTestWorker(): Promise<string> {
  workerBundle ??= (async () => {
    bundleRoot = await mkdtemp(join(tmpdir(), 'orca-journal-fixture-worker-'))
    const path = join(bundleRoot, 'journal-sql-worker-entry.cjs')
    await build({
      entryPoints: [
        resolve('src/main/native-chat/agent-session-journal/journal-sql-worker-entry.ts')
      ],
      outfile: path,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
      banner: { js: journalNativeTestInstrumentation }
    })
    return path
  })()
  return workerBundle
}

const nativeOpen = JournalHostDatabase.open
beforeEach(() => {
  vi.spyOn(JournalHostDatabase, 'open').mockImplementation(async (directory, workerPath) =>
    nativeOpen.call(JournalHostDatabase, directory, workerPath ?? (await prepareTestWorker()))
  )
})

afterAll(async () => {
  await closeTestJournalHostDatabases()
  if (bundleRoot) {
    await rm(bundleRoot, { recursive: true, force: true })
  }
})

export async function openTestJournalHostDatabase(
  stateDirectory: string
): Promise<JournalHostDatabase> {
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
    const database = await JournalHostDatabase.open(directory, await prepareTestWorker())
    opened.set(directory, database)
    return database
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
      const database = await openTestJournalHostDatabase(stateDirectory)
      if (fixture.legacyInputs) {
        await seedLegacyTestJournal(database, options)
      }
      const { openAgentSessionJournal } = await import('./journal-store-factory')
      const journal = await openAgentSessionJournal({ ...options, database })
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

/** Input-parser fixtures explicitly found an epoch in the shipped input format. */
export async function seedLegacyTestJournal(
  database: JournalHostDatabase,
  options: Omit<TestJournalOptions, 'stateDirectory'>
): Promise<void> {
  if (database.readOnly) {
    return
  }
  await database.transaction(async (plan) => {
    if (
      await plan.read
        .prepare('SELECT epoch FROM journal_sessions WHERE session_id = ?')
        .get(options.identity.sessionId)
    ) {
      return
    }
    const epoch = options.mintEpoch?.() ?? randomUUID()
    publishTestJournalEpoch(plan, options.identity.sessionId, epoch, options.identity.workspaceId)
    insertTestJournalRow(plan, options.identity.sessionId, {
      kind: 'epoch',
      v: journalRowSchemaVersion([]),
      epoch,
      seq: 1,
      fence: 0,
      ts: options.now?.() ?? Date.now(),
      reason: 'session_created',
      providerHandle: agentSessionJournalProviderHandle(options.identity)
    })
  })
}

export const SAVED_BY_NEWER_ORCA = {
  refusal: {
    code: 'agent_session_journal_unreadable',
    details: { reason: 'journalWrittenByNewerOrca' }
  }
}

export async function loadTestJournal(
  stateDirectory: string,
  sessionId: string
): Promise<JournalLoad | null> {
  const database = await openTestJournalHostDatabase(stateDirectory)
  return database.read((read) => restoreJournalAsync(read, sessionId))
}
