import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import { malformedRowsDisclosure, quarantineCorruptSuffix } from './journal-corruption-quarantine'
import { ensureJournalDir } from './journal-log-file'
import { loadJournal, type JournalLoad } from './journal-open'
import { assertJournalPhysicalCapacity, journalDirectoryBytes } from './journal-physical-quota'
import type { JournalRow } from './journal-row-schema'

export function journalStoreLoadedFields(loaded: JournalLoad) {
  return {
    state: loaded.state,
    tailRows: loaded.tailRows,
    compactedThrough: loaded.compactedThrough,
    sizeBytes: loaded.sizeBytes,
    readOnly: loaded.readOnly,
    malformedRows: loaded.malformedRows
  }
}

export async function openJournalStoreState(input: {
  journalDir: string
  sessionId: string
  maxBytes: number
  loaded: JournalLoad | null | undefined
  start: () => Promise<void>
  adopt: (loaded: JournalLoad) => void
  tailRows: () => readonly JournalRow[]
  snapshot: () => AgentJournalSnapshot
  rebuildLifecycle: (snapshot: AgentJournalSnapshot, physicalBytes: number) => void
  appendDisclosure: (
    identity: ReturnType<typeof malformedRowsDisclosure>['identity'],
    body: ReturnType<typeof malformedRowsDisclosure>['body'],
    fence: number
  ) => Promise<unknown>
  highestFence: () => number
  malformedRows: () => number
  readOnly: () => boolean
  setPhysicalBytes: (bytes: number) => void
}): Promise<void> {
  await ensureJournalDir(input.journalDir)
  input.setPhysicalBytes(
    await assertJournalPhysicalCapacity({
      journalDir: input.journalDir,
      sessionId: input.sessionId,
      maxBytes: input.maxBytes
    })
  )
  const loaded =
    input.loaded !== undefined
      ? input.loaded
      : await loadJournal(input.journalDir, input.sessionId, { maxBytes: input.maxBytes })
  if (!loaded) {
    await input.start()
    input.setPhysicalBytes(await journalDirectoryBytes(input.journalDir))
    return
  }
  input.adopt(loaded)
  if (loaded.corrupt && !loaded.readOnly) {
    await quarantineCorruptSuffix(input.journalDir, input.tailRows(), loaded.quarantineRemainder, {
      sessionId: input.sessionId,
      maxBytes: input.maxBytes
    })
  }
  let physicalBytes = await journalDirectoryBytes(input.journalDir)
  input.setPhysicalBytes(physicalBytes)
  // A future-schema/read-only journal is inspection-only. Its reduced state is
  // intentionally empty, and rebuilding reservations from it would mutate the
  // in-memory quota model (and could influence later admission decisions).
  if (!loaded.readOnly) {
    input.rebuildLifecycle(input.snapshot(), physicalBytes)
  }
  if (input.malformedRows() > 0 && !input.readOnly()) {
    const disclosure = malformedRowsDisclosure(input.malformedRows())
    await input.appendDisclosure(disclosure.identity, disclosure.body, input.highestFence())
  }
  physicalBytes = await journalDirectoryBytes(input.journalDir)
  input.setPhysicalBytes(physicalBytes)
}
