import type SyncDatabase from '../sqlite/sync-database'
import { tableExists } from '../opencode-usage/schema-helpers'
import { asRecord, parseJsonObject } from '../ai-vault/session-scanner-values'
import { hasOpenCode2Session } from './transcript-opencode2-sqlite'

export function readOpenCode2ForkCoverage(
  db: SyncDatabase,
  sessionId: string,
  sourceSessionId: string
): string[] {
  db.exec('BEGIN')
  try {
    return readForkCoverageSnapshot(db, sessionId, sourceSessionId)
  } finally {
    db.exec('ROLLBACK')
  }
}

function readForkCoverageSnapshot(
  db: SyncDatabase,
  sessionId: string,
  sourceSessionId: string
): string[] {
  const invalid = () => new Error('OpenCode copied conversation provenance is invalid')
  if (!hasOpenCode2Session(db, sessionId)) {
    if (
      tableExists(db, 'session') &&
      db.prepare('SELECT 1 FROM session WHERE id = ?').get(sessionId)
    ) {
      return [
        ...new Set(
          db
            .prepare(
              "SELECT id FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user' ORDER BY id"
            )
            .all(sessionId)
            .map((value) => {
              const row = asRecord(value)
              if (typeof row?.id !== 'string') {
                throw invalid()
              }
              return row.id
            })
        )
      ]
    }
    throw invalid()
  }
  const child = asRecord(
    db.prepare('SELECT fork_session_id, fork_boundary FROM session_v2 WHERE id = ?').get(sessionId)
  )
  const boundary =
    typeof child?.fork_boundary === 'string' ? parseJsonObject(child.fork_boundary) : null
  if (
    child?.fork_session_id !== sourceSessionId ||
    (boundary?.type !== 'before' && boundary?.type !== 'through') ||
    typeof boundary.messageID !== 'string'
  ) {
    throw invalid()
  }
  const cut = asRecord(
    db
      .prepare('SELECT seq FROM session_message WHERE session_id = ? AND id = ?')
      .get(sourceSessionId, boundary.messageID)
  )
  if (typeof cut?.seq !== 'number') {
    throw invalid()
  }
  const source = new Map(
    db
      .prepare('SELECT seq, type FROM session_message WHERE session_id = ? AND seq <= ?')
      .all(sourceSessionId, boundary.type === 'before' ? cut.seq - 1 : cut.seq)
      .map((value) => {
        const row = asRecord(value)
        return [row?.seq, row?.type]
      })
  )
  const copied = db
    .prepare('SELECT id, seq, type FROM session_message WHERE session_id = ? ORDER BY seq')
    .all(sessionId)
    .map(asRecord)
  let prefix: string | undefined
  const ids: string[] = []
  for (const row of copied) {
    if (typeof row?.id !== 'string' || typeof row.seq !== 'number') {
      throw invalid()
    }
    const suffix = /^(msg_.+)_([0-9]+)$/.exec(row.id)
    if (!suffix) {
      continue
    }
    if (
      suffix[2] !== String(row.seq) ||
      (prefix !== undefined && prefix !== suffix[1]) ||
      !source.has(row.seq) ||
      source.get(row.seq) !== row.type
    ) {
      throw invalid()
    }
    prefix = suffix[1]
    source.delete(row.seq)
    if (row.type === 'user') {
      ids.push(row.id)
    }
  }
  if ([...source.values()].includes('user')) {
    throw invalid()
  }
  return [...new Set(ids)]
}
