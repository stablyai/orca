// Journal recovery: rehydrate a chat's timeline from provider history.
//
// One trigger: a chat whose replayed prefix is unusable (a gap, an unanchored prefix, a malformed
// row). Its journal stays writable, so it is rebuilt in place on a fresh epoch, and only that chat
// is touched. Damage SQLite itself reports is not recovered here: the open fails, and the chat
// says it cannot be loaded.

import type { AgentType } from '../../../shared/agent-status-types'
import type {
  AgentJournalResetReason,
  AgentSessionJournalIdentity,
  AgentSessionProviderHandle
} from '../../../shared/agent-session-journal-types'
import type { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import { importLegacyTranscriptIntoJournal } from '../agent-session-journal/journal-legacy-import'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'

export type AgentSessionJournalRecovery = {
  trigger: 'journal_corrupt'
  /** What subscribers are told; it forces a clean snapshot reload. */
  reset: AgentJournalResetReason
  epoch: string
  imported: number
  /** Set when provider history could not be read, or held nothing to restore; the
   *  intact journal prefix remains live. */
  error?: string
}

export type AgentSessionJournalOpened = {
  journal: AgentSessionJournal
  recovery: AgentSessionJournalRecovery | null
}

/** The provider's own session id, which is what the transcript readers index
 *  by — never the Orca session id. */
export function providerHistoryId(handle: AgentSessionProviderHandle): string {
  if (handle.kind === 'codex') {
    return handle.threadId
  }
  return handle.kind === 'claude' ? handle.sessionId : handle.value
}

export async function openAgentSessionJournalWithRecovery(input: {
  identity: AgentSessionJournalIdentity
  database: JournalHostDatabase
  fence: number
  /** Resolve directly to a transcript instead of discovering it by session id. */
  historyFilePath?: string | null
  deferPerSessionImport?: boolean
}): Promise<AgentSessionJournalOpened> {
  const journal = await openAgentSessionJournal({
    identity: input.identity,
    database: input.database,
    deferPerSessionImport: input.deferPerSessionImport
  })
  if (!journal.needsRebuild) {
    return { journal, recovery: null }
  }
  // `open()` dropped the unusable suffix; a successful import rolls once more so
  // the rebuilt timeline is the only content of its epoch. A throw leaves nothing to release:
  // the store holds no connection.
  return { journal, recovery: await rehydrate({ ...input, journal, trigger: 'journal_corrupt' }) }
}

async function rehydrate(input: {
  identity: AgentSessionJournalIdentity
  journal: AgentSessionJournal
  fence: number
  historyFilePath?: string | null
  trigger: AgentSessionJournalRecovery['trigger']
}): Promise<AgentSessionJournalRecovery> {
  const reset: AgentJournalResetReason = 'epoch_changed'
  const result = await importLegacyTranscriptIntoJournal({
    journal: input.journal,
    agent: input.identity.agent satisfies AgentType,
    sessionId: providerHistoryId(input.identity.providerHandle),
    fence: input.fence,
    ...(input.historyFilePath ? { options: { filePath: input.historyFilePath } } : {})
  })
  // A transcript that held nothing is the same outcome as one that could not be
  // read: nothing was restored, so the repair's marker has to stand and be
  // retried on a later attach rather than being retired as a completed recovery.
  if (!result.ok || !result.replaced) {
    return {
      trigger: input.trigger,
      reset,
      epoch: input.journal.epoch,
      imported: 0,
      error: result.ok ? 'Provider history held no messages to restore' : result.error
    }
  }
  return {
    trigger: input.trigger,
    reset,
    epoch: result.epoch,
    imported: result.imported
  }
}
