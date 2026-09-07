import { mkdir } from 'node:fs/promises'
import type { AgentType } from '../../../shared/agent-status-types'
import {
  findJournalFileFormatRemnant,
  journalFileFormatRemnantDisclosure
} from './journal-file-format-remnant'
import type { JournalLoad } from './journal-open'
import { journalRepairDisclosure, type JournalRepairDisclosure } from './journal-repair-disclosure'

/** What any of this file's disclosures hands the store — a repair's, or the
 *  pre-SQLite notice's. Same shape, and neither is only a repair. */
type JournalDisclosure = JournalRepairDisclosure

export async function ensureJournalDir(journalDir: string): Promise<void> {
  await mkdir(journalDir, { recursive: true })
}

export function journalStoreLoadedFields(loaded: JournalLoad) {
  return {
    state: loaded.state,
    readOnly: loaded.readOnly,
    malformedRows: loaded.malformedRows
  }
}

export async function openJournalStoreState(input: {
  journalDir: string
  loaded: JournalLoad | null | undefined
  replay: () => JournalLoad | null
  /** Drops the rejected suffix and records the rebuild it owes, in ONE
   *  transaction. Corruption is not preserved; replay keeps reporting `corrupt`
   *  until provider history republishes the epoch or the session writes past
   *  `contentFrom`, the first sequence the repair left free. */
  deleteSuffix: (fromSeq: number, contentFrom: number) => number
  start: () => void
  adopt: (loaded: JournalLoad) => void
  /** Republishes an anchor row for an epoch a repair emptied. */
  publishRepairEpoch: () => void
  appendDisclosure: (
    identity: JournalRepairDisclosure['identity'],
    body: JournalRepairDisclosure['body'],
    fence: number
  ) => Promise<unknown>
  agent: AgentType
  highestFence: () => number
  malformedRows: () => number
  setMalformedRows: (count: number) => void
  readOnly: () => boolean
}): Promise<void> {
  const loaded = input.loaded !== undefined ? input.loaded : input.replay()
  if (!loaded) {
    input.start()
    await discloseFileFormatRemnant(input)
    return
  }
  input.adopt(loaded)
  if (loaded.truncateFrom !== undefined && !loaded.readOnly) {
    input.deleteSuffix(loaded.truncateFrom, loaded.state.lastSequence + 1)
  }
  // A repair that took every live row leaves the epoch with no anchor. Publish
  // one before anything can append into it: an ordinary row at sequence 1 would
  // replay as a clean timeline and hide that the history was never rebuilt.
  if (!loaded.readOnly && loaded.state.lastSequence === 0) {
    input.publishRepairEpoch()
    // The replacement epoch adopts a clean load; what this open's repair did is
    // still the answer `repair` and the disclosure below owe the caller.
    input.setMalformedRows(loaded.malformedRows)
  }
  if (input.malformedRows() > 0 && !input.readOnly()) {
    const disclosure = journalRepairDisclosure({ malformedRows: input.malformedRows() })
    await input.appendDisclosure(disclosure.identity, disclosure.body, input.highestFence())
  }
  // Founding the epoch and appending the row are two transactions, and a
  // committed epoch sends every later open down this branch instead. Anything
  // that interrupts between them — a quit during startup restore, a failed
  // append — would otherwise lose the message for good. An epoch holding nothing
  // is exactly the state that append was owed, so offer it again.
  //
  // Never onto a repair, though: `loaded.state` is the PRE-repair load, so a
  // journal this open just emptied looks identical. The repair's epoch is the
  // marker that its history was deleted and never rebuilt, and any row that is
  // not the repair's own disclosure retires it — this row would silently stop
  // the session ever asking the provider for that history again.
  if (!loaded.corrupt && loaded.state.items.size === 0 && loaded.state.submissions.size === 0) {
    await discloseFileFormatRemnant(input)
  }
}

/** Says what happened to a chat whose history is in the abandoned file format.
 *  Upserts by a constant identity, so the offer above is exactly-once in effect:
 *  once the row exists the epoch is no longer empty. */
async function discloseFileFormatRemnant(input: {
  journalDir: string
  agent: AgentType
  appendDisclosure: (
    identity: JournalDisclosure['identity'],
    body: JournalDisclosure['body'],
    fence: number
  ) => Promise<unknown>
  highestFence: () => number
  readOnly: () => boolean
}): Promise<void> {
  if (input.readOnly()) {
    return
  }
  const transcriptPath = findJournalFileFormatRemnant(input.journalDir)
  if (!transcriptPath) {
    return
  }
  const disclosure = journalFileFormatRemnantDisclosure({ transcriptPath, agent: input.agent })
  await input.appendDisclosure(disclosure.identity, disclosure.body, input.highestFence())
}
