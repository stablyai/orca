import { sessionCrewChanges } from '../../orchestration/crew/crew-changes'
// Launch admission opens the single-writer store before chat-host installation; both must reuse this instance.

import { existsSync } from 'node:fs'
import { journalDatabasePath } from '../../../native-chat/agent-session-journal/database/journal-host-database'
import { journalDomainDatabasePath } from '../../../native-chat/agent-session-journal/database/journal-domain-database'
import { journalDatabaseHoldsAgentSessions } from '../../../native-chat/agent-session-journal/database/journal-database'
import { AgentSessionRecordStore } from './agent-session-record-store'
import type { JournalSqlDatabase } from '../../../native-chat/agent-session-journal/database/journal-sql-database'
import { openStructuredAgentSessionSqlJournalDatabase } from '../structured-agent-session-journal-open'
import type { StructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'

export type AgentSessionRecordStoreLocation = {
  stateDirectory: string
  hostId: string
  logger: StructuredAgentSessionLogger
  legacySessionTabIds: readonly string[]
  maintenanceAfter?: Promise<void>
} & Pick<
  Parameters<typeof openStructuredAgentSessionSqlJournalDatabase>[0],
  'writerPath' | 'readerPath'
>

export type OpenedAgentSessionRecordStore = {
  journalDatabase: JournalSqlDatabase
  store: AgentSessionRecordStore
}

type RecordStoreSlot = {
  stateDirectory: string
  opened: Promise<OpenedAgentSessionRecordStore>
  /** Nonawaiting readers can inspect the store only after open resolves. */
  store?: AgentSessionRecordStore
  database?: JournalSqlDatabase
  retire?: (opened: OpenedAgentSessionRecordStore | null) => Promise<void>
  retiring?: Promise<void>
}

let opening: RecordStoreSlot | null = null
const pendingDatabaseClose = new Set<JournalSqlDatabase>()

/** Keep failed standalone/open-failure closes owned until a later stop or open retries them. */
export async function closeAgentSessionRecordStoreDatabase(
  database?: JournalSqlDatabase
): Promise<void> {
  if (database) {
    pendingDatabaseClose.add(database)
  }
  for (const pending of pendingDatabaseClose) {
    await pending.close()
    pendingDatabaseClose.delete(pending)
  }
}

export function openAgentSessionRecordStoreOnce(
  location: AgentSessionRecordStoreLocation
): Promise<OpenedAgentSessionRecordStore> {
  if (opening) {
    if (opening.retire) {
      return finishRetirement(opening).then(() => openAgentSessionRecordStoreOnce(location))
    }
    // One process serves one profile; refuse location changes instead of opening a divergent second writer.
    if (opening.stateDirectory !== location.stateDirectory) {
      return Promise.reject(new Error('agent_session_record_store_location_changed'))
    }
    return opening.opened
  }
  const slot: RecordStoreSlot = {
    stateDirectory: location.stateDirectory,
    opened: openRecordStore(location).then(
      (opened) => {
        slot.database = opened.journalDatabase
        if (!slot.retire) {
          slot.store = opened.store
          // A startup opener holds background maintenance until its host's listening milestone.
          void Promise.resolve(location.maintenanceAfter).then(() => {
            if (!slot.retire) {
              void opened.journalDatabase.startMaintenance()
            }
          })
        } else {
          opened.journalDatabase.stopMaintenance()
        }
        if (opening === slot && !slot.retire) {
          sessionCrewChanges.notify(new Set(['topology', 'records']))
        }
        return opened
      },
      (error: unknown) => {
        // Failed opens must leave the next caller able to retry.
        if (opening === slot && !slot.retire) {
          opening = null
        }
        throw error
      }
    )
  }
  opening = slot
  return slot.opened
}

export function peekOpenedAgentSessionRecordStore(): AgentSessionRecordStore | null {
  return opening?.store ?? null
}

async function openRecordStore(
  location: AgentSessionRecordStoreLocation
): Promise<OpenedAgentSessionRecordStore> {
  await closeAgentSessionRecordStoreDatabase()
  const { journalDatabase, records } = await openStructuredAgentSessionSqlJournalDatabase({
    ...location,
    closeFailedOpen: closeAgentSessionRecordStoreDatabase
  })
  try {
    return {
      journalDatabase,
      store: AgentSessionRecordStore.open({
        journalDatabase,
        records,
        hostId: location.hostId,
        legacySessionTabIds: location.legacySessionTabIds
      })
    }
  } catch (error) {
    await closeAgentSessionRecordStoreDatabase(journalDatabase)
    throw error
  }
}

/** Retain the physical owner until its dependents drain and its database actually closes. */
export function retireAgentSessionRecordStore(
  retire: (opened: OpenedAgentSessionRecordStore | null) => Promise<void>
): Promise<void> {
  const slot = opening
  if (!slot) {
    return retire(null)
  }
  if (!slot.retire) {
    slot.retire = retire
    slot.database?.stopMaintenance()
    slot.store = undefined
    sessionCrewChanges.notify(new Set(['topology', 'records']))
  }
  return finishRetirement(slot)
}

function finishRetirement(slot: RecordStoreSlot): Promise<void> {
  if (!slot.retiring) {
    const retire = slot.retire!
    slot.retiring = slot.opened
      .catch(() => null)
      .then(retire)
      .then(() => {
        if (opening === slot) {
          opening = null
        }
      })
      .catch((error: unknown) => {
        slot.retiring = undefined
        throw error
      })
  }
  return slot.retiring
}

/** Whether this profile holds a structured chat: a record or tab in the journal database. */
export function hasPersistedStructuredAgentSessionStore(
  stateDirectory: string,
  fileExists: (path: string) => boolean = existsSync
): boolean {
  const currentPath = journalDomainDatabasePath(stateDirectory)
  const databasePath = fileExists(currentPath) ? currentPath : journalDatabasePath(stateDirectory)
  if (!fileExists(databasePath)) {
    return false
  }
  try {
    return journalDatabaseHoldsAgentSessions(databasePath)
  } catch {
    // A database that cannot be read cannot say it is empty.
    return true
  }
}
