// Journal recovery: rehydrate the timeline from provider history.
//
// Two triggers, and they need different destinations. A journal whose prefix is
// unusable is writable, so it is rebuilt in place on a fresh epoch. A journal
// written by a NEWER schema is not writable by this host at all — rebuilding it
// in place would fork the sequence space a newer host still owns — so the
// reconstruction goes to a schema-scoped sibling directory that is only ever
// written by hosts at this version and is never merged back.

import type { AgentType } from '../../../shared/agent-status-types'
import {
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentJournalResetReason,
  type AgentSessionJournalIdentity,
  type AgentSessionProviderHandle
} from '../../../shared/agent-session-journal-types'
import { importLegacyTranscriptIntoJournal } from '../agent-session-journal/journal-legacy-import'
import { loadJournal } from '../agent-session-journal/journal-open'
import {
  openAgentSessionJournal,
  type AgentSessionJournal
} from '../agent-session-journal/journal-store'

export type AgentSessionJournalRecovery = {
  trigger: 'journal_corrupt' | 'schema_unreadable'
  /** What subscribers are told; both force a clean snapshot reload. */
  reset: AgentJournalResetReason
  epoch: string
  imported: number
  /** Set when provider history could not be read; the intact journal prefix remains live. */
  error?: string
}

export type AgentSessionJournalOpened = {
  journal: AgentSessionJournal
  recovery: AgentSessionJournalRecovery | null
}

/** Where a reconstruction lands when the real journal cannot be written. */
export function recoveryJournalDir(journalDir: string): string {
  return `${journalDir}-recovered-v${AGENT_SESSION_JOURNAL_SCHEMA_VERSION}`
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
  journalDir: string
  fence: number
  /** Resolve directly to a transcript instead of discovering it by session id. */
  historyFilePath?: string | null
}): Promise<AgentSessionJournalOpened> {
  const probe = await loadJournal(input.journalDir, input.identity.sessionId)
  if (probe?.readOnly) {
    const journal = await openAgentSessionJournal({
      identity: input.identity,
      journalDir: recoveryJournalDir(input.journalDir)
    })
    return {
      journal,
      recovery: await rehydrate({ ...input, journal, trigger: 'schema_unreadable' })
    }
  }
  const journal = await openAgentSessionJournal({
    identity: input.identity,
    journalDir: input.journalDir
  })
  if (!probe?.corrupt) {
    return { journal, recovery: null }
  }
  // `open()` quarantines the unusable suffix; a successful import rolls once
  // more so the rebuilt timeline is the only content of its epoch.
  return { journal, recovery: await rehydrate({ ...input, journal, trigger: 'journal_corrupt' }) }
}

async function rehydrate(input: {
  identity: AgentSessionJournalIdentity
  journal: AgentSessionJournal
  fence: number
  historyFilePath?: string | null
  trigger: AgentSessionJournalRecovery['trigger']
}): Promise<AgentSessionJournalRecovery> {
  const reset: AgentJournalResetReason =
    input.trigger === 'schema_unreadable' ? 'schema_unreadable' : 'epoch_changed'
  const result = await importLegacyTranscriptIntoJournal({
    journal: input.journal,
    agent: input.identity.agent satisfies AgentType,
    sessionId: providerHistoryId(input.identity.providerHandle),
    fence: input.fence,
    ...(input.historyFilePath ? { options: { filePath: input.historyFilePath } } : {})
  })
  if (!result.ok) {
    return {
      trigger: input.trigger,
      reset,
      epoch: input.journal.epoch,
      imported: 0,
      error: result.error
    }
  }
  return {
    trigger: input.trigger,
    reset,
    epoch: result.epoch,
    imported: result.imported
  }
}
