import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type Database from '../../sqlite/sync-database'
import { usableNativeCopyHeader } from './context-epochs/journal-history-origin'
import {
  claudeRecoveryFragmentBytes,
  readClaudeRecoveryFragmentPage
} from './journal-claude-recovery-fragments'
import { wideField } from './history-import/journal-claude-import-pages'

const ORIGIN_BYTES = claudeRecoveryFragmentBytes('claude-recovery-origin')

type Prefix = readonly [string, string]

export function requireClaudeRecoveryCursor(
  db: Database.Database,
  prefix: Prefix,
  cursor: AgentJournalCursor
): void {
  if (
    prefix[1] !== cursor.epoch ||
    db
      .prepare('SELECT last_sequence FROM journal_chat_state WHERE session_id=? AND epoch=?')
      .get(...prefix)?.last_sequence !== cursor.sequence
  ) {
    throw new Error('Saved Claude history changed during recovery.')
  }
}

export function readClaudeRecoveryOriginHeader(
  db: Database.Database,
  prefix: Prefix,
  providerSessionId?: string
) {
  const row = db
    .prepare(`SELECT json_remove(history_origin_json,'$.raw.ids') AS header
    FROM journal_chat_state WHERE session_id=? AND epoch=?
    AND json_extract(history_origin_json,'$.raw.kind')='native_copy'
    AND json_type(history_origin_json,'$.raw.ids')='array'
    AND NOT EXISTS(
      SELECT 1 FROM json_each(history_origin_json,'$.raw.ids')
      WHERE type<>'text' OR octet_length(atom)=0
    )`)
    .get(...prefix)
  const header = row?.header == null ? null : usableNativeCopyHeader(JSON.parse(String(row.header)))
  if (providerSessionId === undefined) {
    return header
  }
  return header?.agent === 'claude' &&
    header.unit === 'claude-entry' &&
    header.providerHandle.kind === 'claude' &&
    header.providerHandle.sessionId === providerSessionId
    ? header
    : null
}

export function readClaudeRecoveryOriginIds(
  db: Database.Database,
  prefix: Prefix,
  after: { ordinal: number; offset: number }
) {
  const rows = db
    .prepare(`SELECT ids.key AS ordinal, ids.value AS value, ids.fullkey AS path, instr(ids.value,char(0)) AS nul
    FROM journal_chat_state CROSS JOIN json_each(history_origin_json,'$.raw.ids') AS ids
    WHERE session_id=? AND epoch=? AND ids.key>=?`)
    .iterate(...prefix, after.ordinal)
  function* fragments() {
    for (const row of rows) {
      const ordinal = Number(row.ordinal)
      let value = String(row.value)
      if (value.includes('\ufffd') || Number(row.nul) > 0) {
        // Recover the original code units if SQLite decoded an escaped surrogate or NUL.
        const raw = db
          .prepare(`SELECT history_origin_json -> ? AS id
          FROM journal_chat_state WHERE session_id=? AND epoch=?`)
          .get(String(row.path), ...prefix)
        value = JSON.parse(String(raw?.id))
      }
      let offset = ordinal === after.ordinal ? after.offset : 0
      for (const fragment of wideField(['ids', String(ordinal)], value, offset, ORIGIN_BYTES)) {
        yield { ...fragment, at: { ordinal, offset: offset++ } }
      }
    }
  }
  const available = fragments()
  try {
    const { fragments: page, next } = readClaudeRecoveryFragmentPage(available, ORIGIN_BYTES)
    return { fragments: page, next }
  } finally {
    available.return(undefined)
  }
}
