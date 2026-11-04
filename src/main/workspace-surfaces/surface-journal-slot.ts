import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { openStructuredAgentSessionJournalDatabase } from '../runtime/agent-session/structured-agent-session-journal-open'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

type Location = { stateDirectory: string; logger: StructuredAgentSessionLogger }
type Slot = { stateDirectory: string; opened: Promise<JournalHostDatabase> }
let slot: Slot | null = null
const retiring = new Set<JournalHostDatabase>()

/** Native chat construction shares its admitted connection until all record users drain. */
export function openSurfaceJournalOnce(location: Location): Promise<JournalHostDatabase> {
  if (slot) {
    return slot.stateDirectory === location.stateDirectory
      ? slot.opened
      : Promise.reject(new Error('agent_session_record_store_location_changed'))
  }
  const next: Slot = {
    stateDirectory: location.stateDirectory,
    opened: closeSurfaceJournal().then(() => openStructuredAgentSessionJournalDatabase(location))
  }
  slot = next
  void next.opened.catch(() => {
    if (slot === next) {
      slot = null
    }
  })
  return next.opened
}

/** Runtime teardown transfers the one connection only after its users have drained. */
export async function releaseSurfaceJournal(): Promise<JournalHostDatabase | null> {
  const released = slot
  slot = null
  return released ? released.opened.catch(() => null) : null
}

/** Retain failed closes and finish them before admitting another connection. */
export async function closeSurfaceJournal(database?: JournalHostDatabase): Promise<void> {
  if (database) {
    retiring.add(database)
  }
  for (const pending of retiring) {
    await pending.close()
    retiring.delete(pending)
  }
}
