import {
  installSurfaceNativeRuntimeOwner,
  type SurfaceNativeRuntimeOwner
} from '../../../workspace-surfaces/surface-native-runtime-owner'
import { sessionCrewChanges } from '../../orchestration/crew/crew-changes'
// Launch admission opens the single-writer store before chat-host installation; both must reuse this instance.
// Quit-only edge: failed host teardown can leave its connection open after releasing the slot; a post-stop open lasts until exit.

import { existsSync } from 'node:fs'
import {
  JournalHostDatabase,
  journalDatabasePath
} from '../../../native-chat/agent-session-journal/journal-host-database'
import { AgentSessionRecordStore } from './agent-session-record-store'
import {
  openSurfaceJournalOnce,
  releaseSurfaceJournal,
  closeSurfaceJournal
} from '../../../workspace-surfaces/surface-journal-slot'
import type { StructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/structured-agent-session-logger'

export type AgentSessionRecordStoreLocation = {
  stateDirectory: string
  hostId: string
  logger: StructuredAgentSessionLogger
  legacySessionTabIds: readonly string[]
  surfaceOwner?: SurfaceNativeRuntimeOwner
}

export type OpenedAgentSessionRecordStore = {
  journalDatabase: JournalHostDatabase
  store: AgentSessionRecordStore
}

type RecordStoreSlot = {
  stateDirectory: string
  opened: Promise<OpenedAgentSessionRecordStore>
  /** Nonawaiting readers can inspect the store only after open resolves. */
  store?: AgentSessionRecordStore
}

let opening: RecordStoreSlot | null = null

/** Keep failed standalone/open-failure closes owned until a later stop or open retries them. */
export async function closeAgentSessionRecordStoreDatabase(
  database?: JournalHostDatabase
): Promise<void> {
  await closeSurfaceJournal(database)
}

export function openAgentSessionRecordStoreOnce(
  location: AgentSessionRecordStoreLocation
): Promise<OpenedAgentSessionRecordStore> {
  if (opening) {
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
        slot.store = opened.store
        if (opening === slot) {
          sessionCrewChanges.notify(new Set(['topology', 'records']))
        }
        return opened
      },
      (error: unknown) => {
        // Failed opens must leave the next caller able to retry.
        if (opening === slot) {
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
  const journalDatabase = await openSurfaceJournalOnce(location)
  if (location.surfaceOwner) {
    await installSurfaceNativeRuntimeOwner(journalDatabase, location.surfaceOwner, location.hostId)
  }
  return {
    journalDatabase,
    store: await AgentSessionRecordStore.open({
      journalDatabase,
      hostId: location.hostId,
      legacySessionTabIds: location.legacySessionTabIds
    })
  }
}

/** Transfer ownership of the open slot to chat-host teardown or the caller that will close it. */
export async function releaseAgentSessionRecordStore(): Promise<OpenedAgentSessionRecordStore | null> {
  const released = opening
  opening = null
  // A terminal-only runtime has a journal but no provider record-store instance.
  const journalDatabase = await releaseSurfaceJournal()
  if (released) {
    sessionCrewChanges.notify(new Set(['topology', 'records']))
  }
  const records = released ? await released.opened.catch(() => null) : null
  if (!records && journalDatabase) {
    await closeAgentSessionRecordStoreDatabase(journalDatabase)
  }
  return records
}

/** Whether this profile holds a structured chat: a record or tab in the journal database. */
export async function hasPersistedStructuredAgentSessionStore(
  stateDirectory: string,
  fileExists: (path: string) => boolean = existsSync
): Promise<boolean> {
  const databasePath = journalDatabasePath(stateDirectory)
  if (!fileExists(databasePath)) {
    return false
  }
  try {
    return await JournalHostDatabase.holdsSessions(stateDirectory)
  } catch {
    // A database that cannot be read cannot say it is empty.
    return true
  }
}
