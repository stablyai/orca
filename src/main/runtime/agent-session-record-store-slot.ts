// Launch admission opens the single-writer store before chat-host installation; both must reuse this instance.
// Quit-only edge: failed host teardown can leave its connection open after releasing the slot; a post-stop open lasts until exit.

import { AgentSessionRecordStore } from './agent-session-record-store'
import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { openStructuredAgentSessionJournalDatabase } from './structured-agent-session-journal-open'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

export type AgentSessionRecordStoreLocation = {
  stateDirectory: string
  hostId: string
  logger: StructuredAgentSessionLogger
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
  const journalDatabase = openStructuredAgentSessionJournalDatabase(location)
  try {
    return {
      journalDatabase,
      store: AgentSessionRecordStore.open({ journalDatabase, hostId: location.hostId })
    }
  } catch (error) {
    journalDatabase.close()
    throw error
  }
}

/** Transfer ownership of the open slot to chat-host teardown or the caller that will close it. */
export async function releaseAgentSessionRecordStore(): Promise<OpenedAgentSessionRecordStore | null> {
  const released = opening
  opening = null
  return released ? released.opened.catch(() => null) : null
}
