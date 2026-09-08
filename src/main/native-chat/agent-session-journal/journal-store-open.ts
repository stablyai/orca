import { mkdir } from 'node:fs/promises'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentType } from '../../../shared/agent-status-types'
import {
  findJournalFileFormatRemnant,
  journalFileFormatRemnantDisclosure
} from './journal-file-format-remnant'
import type { JournalLoad } from './journal-open'
import { journalRepairDisclosure, type JournalRepairDisclosure } from './journal-repair-disclosure'
import { staleSubagentRosterRevisions } from './journal-subagent-liveness'

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
  /** Seals the original and publishes a readable generation in one transaction. */
  repairGeneration: (loaded: JournalLoad) => void
  start: () => void
  adopt: (loaded: JournalLoad) => void
  appendItem: (
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
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
  if (!loaded.readOnly && (loaded.truncateFrom !== undefined || loaded.state.lastSequence === 0)) {
    input.repairGeneration(loaded)
    input.setMalformedRows(loaded.malformedRows)
  }
  if (input.malformedRows() > 0 && !input.readOnly()) {
    const disclosure = journalRepairDisclosure({ malformedRows: input.malformedRows() })
    await input.appendItem(disclosure.identity, disclosure.body, input.highestFence())
  }
  await settleStaleSubagentRosters(input, loaded)
  // Retry a founding disclosure after a crash, but never retire a repair's rebuild marker.
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
  appendItem: (
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
  await input.appendItem(disclosure.identity, disclosure.body, input.highestFence())
}

/**
 * Retires a `working` subagent roster the previous host never got to settle.
 *
 * Skipped on a corrupt load: that journal is still owed a rebuild from provider
 * history, and content written past the repair's free sequence retires the
 * demand for it.
 */
async function settleStaleSubagentRosters(
  input: {
    appendItem: (
      identity: AgentJournalItemIdentity,
      body: AgentJournalItemBody,
      fence: number
    ) => Promise<unknown>
    highestFence: () => number
    readOnly: () => boolean
  },
  loaded: JournalLoad
): Promise<void> {
  if (input.readOnly() || loaded.corrupt) {
    return
  }
  for (const revision of staleSubagentRosterRevisions(loaded.state.items.values())) {
    await input.appendItem(revision.identity, revision.body, input.highestFence())
  }
}
