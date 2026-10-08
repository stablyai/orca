// What startup owes native chats. Each listed chat that was settled shows its saved status without
// its history being opened. Only two kinds open, at once: a chat the restart cut mid-turn, whose open
// settles its journal and publishes the verdict that settle wrote, and a listed chat undelivered mail
// waits on, whose idle edge re-drives that mail.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type {
  SavedStructuredSessionEntry,
  SavedStructuredSessionStatus
} from '../../../shared/structured-agent-session-saved-status'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import { structuredAgentSessionRecordSummaryFields } from './structured-agent-session-status-summary'

function wasCut(saved: SavedStructuredSessionStatus): boolean {
  return saved.summary.status === 'working' || saved.summary.status === 'attention'
}

/** A settled chat's row as its open would publish it: the journal's half as saved, the rest from
 *  the record, which a change made while nothing was saved (a model switch, a rename) updates. */
export function restoredStructuredSessionSummary(
  saved: SavedStructuredSessionStatus,
  record: AgentSessionRecord
): AgentSessionStatusSummary {
  return {
    ...saved.summary,
    workspaceId: record.location.workspaceId,
    agent: record.provider,
    ...structuredAgentSessionRecordSummaryFields(record)
  }
}

/** Runs after the startup lease check. A failed open is logged: the chat still lists, and its own
 *  next open settles it again. */
export async function restoreSavedStructuredAgentSessionStatuses(input: {
  /** Listed chats, already filtered to the ones the tab list shows. */
  listed: readonly string[]
  /** Chats undelivered orchestration mail waits on. */
  owedMail: readonly string[]
  saved: readonly SavedStructuredSessionEntry[]
  getRecord: (sessionId: string) => AgentSessionRecord | null
  /** A record a newer build wrote: its saved status is that build's, so it is kept. */
  isUnreadable: (sessionId: string) => boolean
  restoreSaved: (
    summary: AgentSessionStatusSummary,
    location: AgentSessionRecord['location']
  ) => void
  dropSaved: (sessionId: string) => void
  /** Opens each chat, which settles what its gone agent left running and publishes its row. */
  settle: (sessionIds: readonly string[]) => Promise<void>
  close: (sessionId: string) => Promise<void>
  logger: StructuredAgentSessionLogger
}): Promise<void> {
  const listed = new Set(input.listed)
  const cut: string[] = []
  for (const { sessionId, saved } of input.saved) {
    const record = input.getRecord(sessionId)
    if (!record) {
      if (!input.isUnreadable(sessionId)) {
        input.dropSaved(sessionId)
      }
      continue
    }
    if (!saved) {
      // Another build's entry: kept as written until this chat's own save replaces it.
      continue
    }
    if (wasCut(saved)) {
      cut.push(sessionId)
    } else if (listed.has(sessionId)) {
      input.restoreSaved(restoredStructuredSessionSummary(saved, record), record.location)
    } else {
      // Nothing lists it, and nothing of it is left to settle.
      input.dropSaved(sessionId)
    }
  }
  const owed = [...new Set([...cut, ...input.owedMail.filter((id) => listed.has(id))])]
  if (owed.length === 0) {
    return
  }
  await input.settle(owed).catch((error: unknown) => {
    input.logger.warn('opening chats a restart owes failed', {
      scope: 'saved-status-settle',
      sessionIds: owed,
      error
    })
  })
  for (const sessionId of cut.filter((id) => !listed.has(id))) {
    await input.close(sessionId).catch((error: unknown) => {
      input.logger.warn('closing a settled unlisted chat failed', {
        scope: 'saved-status-close',
        sessionId,
        error
      })
    })
    input.dropSaved(sessionId)
  }
}
