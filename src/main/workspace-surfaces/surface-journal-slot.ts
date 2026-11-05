import { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { openStructuredAgentSessionJournalDatabase } from '../runtime/agent-session/structured-agent-session-journal-open'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

type Location = { stateDirectory: string; logger: StructuredAgentSessionLogger }
type Slot = {
  stateDirectory: string
  opened?: Promise<JournalHostDatabase>
  probe?: Promise<boolean>
}
let slot: Slot | null = null
const retiring = new Set<JournalHostDatabase>()

/** Native chat construction shares its admitted connection until all record users drain. */
export function openSurfaceJournalOnce(location: Location): Promise<JournalHostDatabase> {
  if (slot) {
    if (slot.stateDirectory !== location.stateDirectory) {
      return Promise.reject(new Error('agent_session_record_store_location_changed'))
    }
    if (slot.opened) {
      return slot.opened
    }
  }
  const next: Slot = slot ?? { stateDirectory: location.stateDirectory }
  slot = next
  next.opened = closeSurfaceJournal().then(async () => {
    await next.probe
    return openStructuredAgentSessionJournalDatabase(location)
  })
  void next.opened.catch(() => {
    if (slot === next) {
      slot = null
    }
  })
  return next.opened
}

/** A finite pre-open probe closes before this location can acquire its writable owner. */
export function surfaceJournalHoldsSessions(stateDirectory: string): Promise<boolean> {
  if (slot && slot.stateDirectory !== stateDirectory) {
    return Promise.reject(new Error('agent_session_record_store_location_changed'))
  }
  if (slot?.opened) {
    return slot.opened.then((database) => database.read((read) => read.probe()))
  }
  const next = (slot ??= { stateDirectory })
  next.probe ??= JournalHostDatabase.holdsSessions(stateDirectory).finally(() => {
    if (slot === next && !next.opened) {
      slot = null
    }
  })
  return next.probe
}

/** Runtime teardown transfers the one connection only after its users have drained. */
export async function releaseSurfaceJournal(): Promise<JournalHostDatabase | null> {
  const released = slot
  if (!released?.opened) {
    await released?.probe?.catch(() => undefined)
  }
  if (slot === released) {
    slot = null
  }
  if (released?.opened) {
    return released.opened.catch(() => null)
  }
  return null
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
