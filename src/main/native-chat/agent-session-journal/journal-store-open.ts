import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalLoad } from './journal-open'
import { failLoadOnUnloadableJournal } from './journal-open-failure'
import { staleSubagentRosterRevisions } from './journal-subagent-liveness'

export async function openJournalStoreState(input: {
  sessionId: string
  replay: () => JournalLoad | null
  start: () => void
  adopt: (loaded: JournalLoad) => void
  appendItem: (
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    fence: number
  ) => Promise<unknown>
  highestFence: () => number
}): Promise<void> {
  const loaded = input.replay()
  // An epoch named but holding no row (a crash inside an older build's repair) has nothing to
  // keep, so it is founded afresh like a chat with no journal; no row is deleted.
  if (!loaded || (!loaded.newer && !loaded.damage && loaded.state.lastSequence === 0)) {
    input.start()
    return
  }
  failLoadOnUnloadableJournal(input.sessionId, loaded)
  input.adopt(loaded)
  await settleStaleSubagentRosters(input, loaded)
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
