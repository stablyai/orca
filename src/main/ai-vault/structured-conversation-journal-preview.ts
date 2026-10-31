import { z } from 'zod'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { firstStructuredAgentSessionPrompt } from '../../shared/structured-agent-session-first-prompt'
import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import {
  applyJournalRow,
  createJournalReducerState,
  renderJournalState
} from '../native-chat/agent-session-journal/journal-reducer'
import { parseJournalRow } from '../native-chat/agent-session-journal/journal-row-schema'

const ROW_LIMIT = 41
const ROW_TEXT_LIMIT = 65_536
const Session = z.object({ epoch: z.string().min(1), workspaceId: z.string() })
const Rows = z.array(
  z.object({ seq: z.number().int(), ts: z.number(), rowJson: z.string().max(ROW_TEXT_LIMIT) })
)
const UNKNOWN = { conversationContent: 'unknown' as const }

export type StructuredConversationJournalPreview = {
  conversationContent: NonNullable<AiVaultSession['conversationContent']>
  firstUserPrompt?: string
}

/** Read only a bounded indexed prefix; uncertainty must never hide recoverable history. */
export function structuredConversationJournalPreview(
  database: Pick<JournalHostDatabase, 'db'> | undefined,
  record: Pick<AgentSessionRecord, 'sessionId' | 'location'>
): StructuredConversationJournalPreview {
  try {
    if (!database) {
      return UNKNOWN
    }
    const db = database.db
    const session = Session.safeParse(
      db
        .prepare(
          'SELECT epoch, workspace_id AS workspaceId FROM journal_sessions WHERE session_id = ?'
        )
        .get(record.sessionId)
    )
    if (!session.success || session.data.workspaceId !== record.location.workspaceId) {
      return UNKNOWN
    }
    const { epoch } = session.data
    const entries = Rows.safeParse(
      db
        .prepare(`SELECT seq, ts, substr(row_json, 1, ?) AS rowJson FROM journal_rows
      WHERE session_id = ? AND epoch = ? ORDER BY seq ASC LIMIT ?`)
        .all(ROW_TEXT_LIMIT + 1, record.sessionId, epoch, ROW_LIMIT)
    )
    if (!entries.success || entries.data.length === 0) {
      return UNKNOWN
    }
    const state = createJournalReducerState(record.sessionId, epoch)
    let creationOnly = false
    let hasContent = false
    for (const [index, entry] of entries.data.entries()) {
      const parsed = parseJournalRow(entry.rowJson)
      if (
        !parsed.ok ||
        parsed.row.epoch !== epoch ||
        parsed.row.seq !== entry.seq ||
        entry.seq !== index + 1
      ) {
        return UNKNOWN
      }
      const row = parsed.row
      if ((index === 0) !== (row.kind === 'epoch')) {
        return UNKNOWN
      }
      if (row.kind === 'epoch') {
        creationOnly =
          row.reason === 'session_created' &&
          row.historyOrigin === undefined &&
          row.recovered !== true
      } else {
        hasContent ||=
          row.kind === 'item' ||
          row.kind === 'submission' ||
          (row.kind === 'queue' && 'body' in row.change) ||
          (row.kind === 'lifecycle-batch' &&
            row.mutations.some((mutation) => mutation.kind === 'item'))
      }
      applyJournalRow(state, row, entry.ts)
    }
    const snapshot = renderJournalState(state)
    const firstUserPrompt = firstStructuredAgentSessionPrompt(
      snapshot.items.filter((item) => item.body.kind !== 'message' || item.body.from === undefined)
    )
    return {
      conversationContent:
        entries.data.length === ROW_LIMIT
          ? 'unknown'
          : hasContent
            ? 'present'
            : creationOnly && entries.data.length === 1
              ? 'empty'
              : 'unknown',
      ...(firstUserPrompt ? { firstUserPrompt } : {})
    }
  } catch {
    return UNKNOWN
  }
}
