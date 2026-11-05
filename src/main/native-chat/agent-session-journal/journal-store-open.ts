import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalLoad } from './journal-open'
import { failLoadOnUnloadableJournal } from './journal-open-failure'
import { staleSubagentRosterRevisionSteps } from './journal-subagent-liveness'
import { journalInputOrder } from './journal-input-order'
import { finishJournalStepsAsync } from './journal-reconstruction-steps'
import type { JournalReducerState } from './journal-reducer'

export async function adoptJournalStoreState(
  previous: JournalReducerState,
  loaded: JournalLoad,
  adopt: (state: JournalReducerState) => void
): Promise<void> {
  await finishJournalStepsAsync(
    journalInputOrder(loaded.state).carryRecoverySteps(journalInputOrder(previous))
  )
  adopt(loaded.state)
}

export async function openJournalStoreState(input: {
  sessionId: string
  replay: () => JournalLoad | null
  start: () => void | Promise<void>
  adopt: (loaded: JournalLoad) => void | Promise<void>
  appendItem: (
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    fence: number
  ) => Promise<unknown>
  highestFence: () => number
}): Promise<void> {
  const loaded = input.replay()
  // Empty epochs left by older repairs contain nothing to preserve; found afresh without deleting rows.
  if (!loaded || (!loaded.newer && !loaded.damage && loaded.state.lastSequence === 0)) {
    await input.start()
    return
  }
  failLoadOnUnloadableJournal(input.sessionId, loaded)
  await input.adopt(loaded)
  await settleStaleSubagentRosters(input, loaded)
}

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
  const revisions = await finishJournalStepsAsync(
    staleSubagentRosterRevisionSteps(loaded.state.items.values())
  )
  for (const revision of revisions) {
    await input.appendItem(revision.identity, revision.body, input.highestFence())
  }
}
