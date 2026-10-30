import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { JournalEpochController } from './journal-epoch-controller'
import { restoreJournalPages } from './journal-open'
import { journalCatchUpPace } from './journal-maintenance'
import { journalOpenRefusalError } from './journal-open-failure'
import type { JournalStoreHost } from './journal-store-collaborators'
import { openJournalStoreState } from './journal-store-open'
import { AgentSessionJournalError } from './journal-write-guards'

export async function restoreJournalStore(
  host: JournalStoreHost,
  collaborators: { epochController: JournalEpochController }
): Promise<void> {
  const database = host.database()
  if (database.readOnly) {
    throw journalOpenRefusalError(
      new AgentSessionJournalError(
        'journal_read_only',
        `agent-session journal for ${host.identity.sessionId} is in a newer Orca's database`
      )
    )
  }
  const pace = journalCatchUpPace()
  const pages = restoreJournalPages(() => database.db, host.identity.sessionId)
  let step = pace.work(() => pages.next())
  while (!step.done) {
    await pace.rest()
    step = pace.work(() => pages.next())
  }
  const loaded = step.value
  return openJournalStoreState({
    sessionId: host.identity.sessionId,
    replay: () => loaded,
    start: () => collaborators.epochController.start('session_created', 0),
    adopt: host.adopt,
    // Recovery revisions must not count as new provider output.
    appendItem: (identity, body, fence) =>
      host.journal().appendItem(identity, body, {
        fence,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE,
        recovered: true
      }),
    highestFence: () => host.state().highestFence
  })
}
