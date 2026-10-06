// The process's one durable agent-session record store, opened on its own.
//
// The launch ledger lives in this store, and admitting a launch is the first thing every replay-safe
// `agent.launch` does — a terminal launch included. Reaching the store used to mean installing the
// whole chat host (provider adapters, the host, the model catalog) first. The store is opened here
// instead and the chat host, when something needs it, is built on this same instance: the store is
// a single writer, so a second copy of it would diverge.
//
// Known edges, both reachable only once quit has begun (stop has no other production caller): a
// stop whose host teardown fails empties the slot while that host still holds its store open, so a
// later admission would open a second one; and a store opened after stop is closed by nothing but
// process exit.

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

let opening: { stateDirectory: string; opened: Promise<OpenedAgentSessionRecordStore> } | null =
  null

export function openAgentSessionRecordStoreOnce(
  location: AgentSessionRecordStoreLocation
): Promise<OpenedAgentSessionRecordStore> {
  if (opening) {
    // Loud rather than a silent second store: one process serves one profile.
    if (opening.stateDirectory !== location.stateDirectory) {
      return Promise.reject(new Error('agent_session_record_store_location_changed'))
    }
    return opening.opened
  }
  const slot = {
    stateDirectory: location.stateDirectory,
    opened: openRecordStore(location).catch((error: unknown) => {
      // A failed open must not poison the slot: the next caller retries.
      if (opening === slot) {
        opening = null
      }
      throw error
    })
  }
  opening = slot
  return slot.opened
}

async function openRecordStore(
  location: AgentSessionRecordStoreLocation
): Promise<OpenedAgentSessionRecordStore> {
  const journalDatabase = await openStructuredAgentSessionJournalDatabase(location)
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

/** Empties the slot and hands back what it held, for whoever closes its database: the chat host's
 *  teardown when one was built on it, the caller otherwise. */
export async function releaseAgentSessionRecordStore(): Promise<OpenedAgentSessionRecordStore | null> {
  const released = opening
  opening = null
  return released ? released.opened.catch(() => null) : null
}
