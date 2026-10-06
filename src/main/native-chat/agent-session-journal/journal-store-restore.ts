// Bringing a store's in-memory state up from disk.
//
// Split out of the store for the same reason its collaborators were: this is the
// ORDERING between import, replay and disclosure, and none of it belongs
// to the store's public surface. Every step here reads or writes through the
// same host the collaborators use, so the store keeps the state and this owns
// the sequence.

import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { JournalEpochController } from './journal-epoch-controller'
import { replayJournal } from './journal-open'
import { failLoadOnUnloadableJournal, journalOpenRefusalError } from './journal-open-failure'
import type { JournalStoreHost } from './journal-store-collaborators'
import { openJournalStoreState } from './journal-store-open'
import { importPerSessionJournal, previewPerSessionJournal } from './journal-per-session-import'
import { AgentSessionJournalError } from './journal-write-guards'

export async function restoreJournalStore(
  host: JournalStoreHost,
  collaborators: { epochController: JournalEpochController }
): Promise<void> {
  const source = {
    database: host.database(),
    identity: host.identity,
    legacyDirectory: host.legacyDirectory
  }
  if (source.database.readOnly) {
    // A newer Orca's database: nothing in it is read as this build's, and nothing is written.
    throw journalOpenRefusalError(
      new AgentSessionJournalError(
        'journal_read_only',
        `agent-session journal for ${host.identity.sessionId} is in a newer Orca's database`
      )
    )
  }
  // A restore reads a chat still in its per-chat file from there, and copies it before its first use.
  const preview = host.deferPerSessionImport ? await previewPerSessionJournal(source) : null
  if (preview) {
    host.owe(async () => {
      await importPerSessionJournal(source)
      const imported = replayJournal(source.database.db, host.identity.sessionId)
      if (!imported) {
        throw new Error(`per-chat journal of ${host.identity.sessionId} was gone before its copy`)
      }
      failLoadOnUnloadableJournal(host.identity.sessionId, imported)
      host.adopt(imported)
    })
  } else {
    // A per-chat file left by an earlier build is this chat's newest history: copied in first.
    await importPerSessionJournal(source)
  }
  return openJournalStoreState({
    sessionId: host.identity.sessionId,
    legacyDirectory: host.legacyDirectory,
    replay: () => preview ?? replayJournal(host.database().db, host.identity.sessionId),
    start: () => collaborators.epochController.start('session_created', 0),
    adopt: host.adopt,
    // File-format and roster notices are about the conversation, not any turn in it.
    appendItem: (identity, body, fence) =>
      host.journal().appendItem(identity, body, { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }),
    agent: host.identity.agent,
    highestFence: () => host.state().highestFence
  })
}
