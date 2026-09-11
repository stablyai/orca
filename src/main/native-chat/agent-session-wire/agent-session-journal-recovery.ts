// Journal recovery: rehydrate the timeline from provider history.
//
// Three triggers, and they need different destinations. A journal whose prefix
// is unusable is writable, so it is rebuilt in place on a fresh epoch. A journal
// written by a NEWER schema is not writable by this host at all — rebuilding it
// in place would fork the sequence space a newer host still owns — so the
// reconstruction goes to a schema-scoped sibling directory that is only ever
// written by hosts at this version and is never merged back. A journal that is
// simply GONE gets the same in-place rebuild, but has to be told apart from a
// session that has no history yet — see `journalHistoryIsMissing`.

import type { AgentType } from '../../../shared/agent-status-types'
import {
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentJournalResetCause,
  type AgentJournalResetReason,
  type AgentSessionJournalIdentity,
  type AgentSessionProviderHandle
} from '../../../shared/agent-session-journal-types'
import { agentSessionJournalCloseRetries } from '../agent-session-journal/journal-close-retry'
import { findJournalFileFormatRemnant } from '../agent-session-journal/journal-file-format-remnant'
import { importLegacyTranscriptIntoJournal } from '../agent-session-journal/journal-legacy-import'
import { loadJournal, type JournalLoad } from '../agent-session-journal/journal-open'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'

export type AgentSessionJournalRecovery = {
  trigger: AgentJournalResetCause
  /** What subscribers are told; every one forces a clean snapshot reload. The
   *  value stays inside the released reason union — `trigger` is what names the
   *  cause for a reader new enough to render it. */
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

/**
 * A journal that is gone, told apart from a session that has none yet.
 *
 * Both answer nothing to a probe, and only the caller knows which it is looking
 * at: `recordPredatesCall` is false exactly when this call is the one creating
 * the session. A record that predates it and names a provider conversation had
 * history; an opaque handle names no conversation, so there is nothing to
 * rebuild and an empty timeline is the honest one.
 */
export function journalHistoryIsMissing(input: {
  probe: JournalLoad | null
  identity: AgentSessionJournalIdentity
  journalDir: string
  recordPredatesCall: boolean
}): boolean {
  if (input.probe) {
    return input.probe.historyMissing === true
  }
  return (
    input.recordPredatesCall &&
    input.identity.providerHandle.kind !== 'opaque' &&
    // A pre-SQLite remnant IS the history, in a format this build cannot read.
    // It already has the disclosure that says so, and a rebuild would delete it.
    findJournalFileFormatRemnant(input.journalDir) === null
  )
}

export async function openAgentSessionJournalWithRecovery(input: {
  identity: AgentSessionJournalIdentity
  journalDir: string
  fence: number
  /** Resolve directly to a transcript instead of discovering it by session id. */
  historyFilePath?: string | null
  /** See `journalHistoryIsMissing`. Default false: a caller that cannot tell
   *  must not turn a brand-new session into one owed a rebuild forever. */
  recordPredatesCall?: boolean
}): Promise<AgentSessionJournalOpened> {
  const probe = loadJournal(input.journalDir, input.identity.sessionId)
  if (probe?.readOnly) {
    const journal = await openAgentSessionJournal({
      identity: input.identity,
      journalDir: recoveryJournalDir(input.journalDir)
    })
    return { journal, recovery: await rehydrateOrClose(input, journal, 'schema_unreadable') }
  }
  const missing = journalHistoryIsMissing({
    probe,
    identity: input.identity,
    journalDir: input.journalDir,
    recordPredatesCall: input.recordPredatesCall === true
  })
  const journal = await openAgentSessionJournal({
    identity: input.identity,
    journalDir: input.journalDir
  })
  if (missing) {
    // The open above founded a `session_created` epoch, which reads back as a
    // session that never had a past. Replacing it with the missing-history
    // anchor is what keeps the rebuild owed when the import below fails — and
    // an anchor already in place is not re-rolled, or every attach would force
    // every reader back to a fresh snapshot.
    if (!probe?.historyMissing) {
      await journal.rollEpoch('journal_missing', input.fence)
    }
    return { journal, recovery: await rehydrateOrClose(input, journal, 'journal_missing') }
  }
  if (!probe?.corrupt) {
    return { journal, recovery: null }
  }
  // `open()` drops the unusable suffix; a successful import rolls once more so
  // the rebuilt timeline is the only content of its epoch.
  return { journal, recovery: await rehydrateOrClose(input, journal, 'journal_corrupt') }
}

/** `importLegacyTranscriptIntoJournal` can THROW rather than report `ok: false`
 *  — a journal write failure, for instance — and nothing else holds a reference
 *  to the journal this function just opened. A close that rejects is retryable,
 *  so the journal is retained rather than dropped with its handle still open. */
async function rehydrateOrClose(
  input: {
    identity: AgentSessionJournalIdentity
    fence: number
    historyFilePath?: string | null
  },
  journal: AgentSessionJournal,
  trigger: AgentSessionJournalRecovery['trigger']
): Promise<AgentSessionJournalRecovery> {
  try {
    return await rehydrate({ ...input, journal, trigger })
  } catch (error) {
    await agentSessionJournalCloseRetries.closeOrRetain(journal)
    throw error
  }
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
