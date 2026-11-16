// @orca-isolated-worker -- Suite hooks own the temporary SQL worker bundle.
import { afterAll } from 'vitest'
/** Centralize store fixtures in the worker-owned journal DB; closeTestAgentSessionRecordStores owns their cleanup. */

import { resolve } from 'node:path'
import { withTestAgentSessionDatabase } from './agent-session-record-store-persistence.test-fixture'
import { JOURNAL_DOMAIN_SCHEMA_VERSION } from '../../../native-chat/agent-session-journal/database/journal-domain-migrations'
import { JournalSqlDatabase } from '../../../native-chat/agent-session-journal/database/journal-sql-database'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from '../../../native-chat/agent-session-journal/journal-sql-worker-bundle.test-fixture'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { openAgentSessionRecordStoreOnce } from './agent-session-record-store-slot'
import { ensureStructuredAgentSessionHost } from '../structured-agent-session-runtime'

const TEST_HOST_ID = 'local'

const databases = new Map<string, Promise<JournalSqlDatabase>>()

afterAll(closeTestAgentSessionRecordStores)

export async function ensureTestStructuredAgentSessionHost(
  deps: Parameters<typeof ensureStructuredAgentSessionHost>[0]
): ReturnType<typeof ensureStructuredAgentSessionHost> {
  await openTestAgentSessionRecordStoreSlot({
    stateDirectory: deps.stateDirectory,
    hostId: deps.hostId,
    logger: deps.logger,
    legacySessionTabIds: deps.legacySessionTabIds ?? []
  })
  return ensureStructuredAgentSessionHost(deps)
}

export function openTestAgentSessionRecordStoreSlot(
  location: Omit<
    Parameters<typeof openAgentSessionRecordStoreOnce>[0],
    'writerPath' | 'readerPath' | 'onMaintenanceTick'
  > &
    Partial<Pick<Parameters<typeof openAgentSessionRecordStoreOnce>[0], 'onMaintenanceTick'>>
): ReturnType<typeof openAgentSessionRecordStoreOnce> {
  return openAgentSessionRecordStoreOnce({
    onMaintenanceTick: () => {},
    ...location,
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath()
  })
}

/** Stores reopened in one directory share its writer, like one runtime's slot. */
export function openTestAgentSessionDatabase(stateDirectory: string): Promise<JournalSqlDatabase> {
  const directory = resolve(stateDirectory)
  let opened = databases.get(directory)
  if (!opened) {
    opened = JournalSqlDatabase.open(directory, {
      writerPath: journalSqlWorkerPath(),
      readerPath: journalSqlReaderPath(),
      onMaintenanceError: () => {}
    })
    databases.set(directory, opened)
  }
  return opened
}

export async function closeTestAgentSessionDatabase(stateDirectory: string): Promise<void> {
  const directory = resolve(stateDirectory)
  const opened = databases.get(directory)
  databases.delete(directory)
  await (await opened)?.close()
}

export async function closeTestAgentSessionRecordStores(): Promise<void> {
  const opened = [...databases.values()]
  databases.clear()
  await Promise.all(opened.map(async (database) => (await database).close()))
}

export async function openTestAgentSessionRecordStore(
  stateDirectory: string,
  options: {
    hostId?: string
    legacySessionTabIds?: readonly string[]
    mode?: 'observe'
  } = {}
): Promise<AgentSessionRecordStore> {
  const journalDatabase = await openTestAgentSessionDatabase(stateDirectory)
  return AgentSessionRecordStore.open({
    journalDatabase,
    records: await (options.mode === 'observe'
      ? journalDatabase.loadRecords()
      : journalDatabase.installRecords()),
    hostId: options.hostId ?? TEST_HOST_ID,
    legacySessionTabIds: options.legacySessionTabIds ?? []
  })
}

/** Seed a newer-build database that this host can read but never write. */
export async function seedTestAgentSessionStoreFromNewerBuild(
  stateDirectory: string
): Promise<void> {
  await closeTestAgentSessionRecordStores()
  await withTestAgentSessionDatabase(stateDirectory, (db) =>
    db.pragma(`user_version = ${JOURNAL_DOMAIN_SCHEMA_VERSION + 1}`)
  )
}
