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
import { failLoadOnUnloadableJournal } from './journal-open-failure'
import { staleSubagentRosterRevisions } from './journal-subagent-liveness'

type JournalDisclosure = ReturnType<typeof journalFileFormatRemnantDisclosure>

export async function openJournalStoreState(input: {
  sessionId: string
  legacyDirectory: string
  replay: () => JournalLoad | null
  start: () => void
  adopt: (loaded: JournalLoad) => void
  appendItem: (
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    fence: number
  ) => Promise<unknown>
  agent: AgentType
  highestFence: () => number
}): Promise<void> {
  const loaded = input.replay()
  // An epoch named but holding no row (a crash inside an older build's repair) has nothing to
  // keep, so it is founded afresh like a chat with no journal; no row is deleted.
  if (!loaded || (!loaded.newer && !loaded.damage && loaded.state.lastSequence === 0)) {
    input.start()
    await discloseFileFormatRemnant(input)
    return
  }
  failLoadOnUnloadableJournal(input.sessionId, loaded)
  input.adopt(loaded)
  await settleStaleSubagentRosters(input, loaded)
  // Founding the epoch and appending the row are two transactions, and a
  // committed epoch sends every later open down this branch instead. Anything
  // that interrupts between them — a quit during startup restore, a failed
  // append — would otherwise lose the message for good. An epoch holding nothing
  // is exactly the state that append was owed, so offer it again.
  if (loaded.state.items.size === 0 && loaded.state.submissions.size === 0) {
    await discloseFileFormatRemnant(input)
  }
}

/** Says what happened to a chat whose history is in the abandoned file format.
 *  Upserts by a constant identity, so the offer above is exactly-once in effect:
 *  once the row exists the epoch is no longer empty. */
async function discloseFileFormatRemnant(input: {
  legacyDirectory: string
  agent: AgentType
  appendItem: (
    identity: JournalDisclosure['identity'],
    body: JournalDisclosure['body'],
    fence: number
  ) => Promise<unknown>
  highestFence: () => number
}): Promise<void> {
  const transcriptPath = findJournalFileFormatRemnant(input.legacyDirectory)
  if (!transcriptPath) {
    return
  }
  const disclosure = journalFileFormatRemnantDisclosure({ transcriptPath, agent: input.agent })
  await input.appendItem(disclosure.identity, disclosure.body, input.highestFence())
}

/** Retires a `working` subagent roster the previous host never got to settle. */
async function settleStaleSubagentRosters(
  input: {
    appendItem: (
      identity: AgentJournalItemIdentity,
      body: AgentJournalItemBody,
      fence: number
    ) => Promise<unknown>
    highestFence: () => number
  },
  loaded: JournalLoad
): Promise<void> {
  for (const revision of staleSubagentRosterRevisions(loaded.state.items.values())) {
    await input.appendItem(revision.identity, revision.body, input.highestFence())
  }
}
