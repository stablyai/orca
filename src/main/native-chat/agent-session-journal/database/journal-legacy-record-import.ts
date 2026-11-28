import {
  isAgentSessionId,
  type AgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { nextAgentSessionFence } from '../../../../shared/agent-session/lifecycle/leases/agent-session-next-fence'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import {
  decodePersistedAgentSessionRecord,
  encodeAgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/records/agent-session-record-stored-form'
import { sessionIdFromFileName } from '../../../ai-vault/parsing/session-scanner-accumulator'
import {
  AGENT_SESSION_TABS_RECORDED,
  withoutRetiredLeaseLatches
} from '../../../runtime/agent-session/records/agent-session-record-rows'
import { isReadableAgentSessionStoreRecord } from '../../../runtime/agent-session/records/agent-session-store-row-rules'
import type Database from '../../../sqlite/sync-database'
import type { SqliteRow } from '../../../sqlite/sqlite-statement'
import { DeletedChats } from '../../chat-deletion/deleted-chats'
import { readDeletedChats } from '../journal-deleted-chats'
import { FORGOTTEN_CHAT_KEY } from '../journal-forgotten-chats'
import { JournalDamageError } from '../replay/journal-open-failure'
import { runJournalTransaction } from './journal-database'
import type { JournalLegacyRecordSnapshot } from './journal-legacy-record-file'
import { assignLegacyVisibleTabs } from './journal-legacy-record-tabs'
import {
  journalLegacyChatRevision,
  journalLegacyChatRevisionKey,
  recordJournalLegacyChatRevision
} from './journal-legacy-source'

function safeFence(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function withBackupFence(
  record: AgentSessionRecord,
  setAside?: { raw: unknown }
): AgentSessionRecord {
  // A lost commit could have granted the backup's next fence. Keep its owner's current fence.
  let floor = nextAgentSessionFence(record.lease) + 1
  const raw = setAside?.raw
  const lease = raw && typeof raw === 'object' && 'lease' in raw ? raw.lease : undefined
  if (lease && typeof lease === 'object' && 'runtimeFence' in lease) {
    const runtimeFence = safeFence(lease.runtimeFence)
    const minimumNextFence =
      'minimumNextFence' in lease && lease.minimumNextFence !== undefined
        ? safeFence(lease.minimumNextFence)
        : undefined
    if (runtimeFence !== null && minimumNextFence !== null) {
      floor = Math.max(floor, nextAgentSessionFence({ runtimeFence, minimumNextFence }))
    }
  }
  if (!Number.isSafeInteger(floor)) {
    throw new JournalDamageError('the original chat record has exhausted its ownership fence')
  }
  return { ...record, lease: { ...record.lease, minimumNextFence: floor } }
}

function readLegacyDeletionAuthority(db: Database.Database) {
  const tombstones = readDeletedChats(db, true)
  const deleted = new DeletedChats(tombstones)
  const excluded = new Set(tombstones.map(({ chatId }) => chatId))
  const hasDeletedConversations = tombstones.some(({ conversations }) => conversations.length > 0)
  for (const { key, value } of db
    .prepare('SELECT key,value FROM agent_session_store_meta WHERE key>=? AND key<?')
    .all(FORGOTTEN_CHAT_KEY, `${FORGOTTEN_CHAT_KEY.slice(0, -1)};`)) {
    const sessionId = String(key).slice(FORGOTTEN_CHAT_KEY.length)
    if (value !== '1' || !isAgentSessionId(sessionId)) {
      throw new JournalDamageError('the original chat store has an unreadable forget marker')
    }
    excluded.add(sessionId)
  }
  return (id: string, record: AgentSessionRecord | undefined): boolean => {
    if (excluded.has(id) || deleted.hasSession(id)) {
      return true
    }
    if (!hasDeletedConversations) {
      return false
    }
    if (!record) {
      throw new JournalDamageError('an unreadable original chat may match a saved deletion')
    }
    return record.providerHandleChain.some(({ handle }) =>
      deleted.hasConversation({
        provider: record.provider,
        providerSessionId:
          record.provider === 'pi' ? sessionIdFromFileName(handle.nativeId) : handle.nativeId
      })
    )
  }
}

type LoadedRecordSnapshot = NonNullable<JournalLegacyRecordSnapshot>

const RECORD_JOINS = `LEFT JOIN legacy_rows p ON p.generation=?1 AND p.section='records' AND p.key=ids.id
  LEFT JOIN legacy_rows u ON u.generation=?1 AND u.section='unusableRecords' AND u.key=ids.id
  LEFT JOIN legacy_rows b ON ?2 AND b.generation='backup' AND b.section='records' AND b.key=ids.id
    AND b.readable=1 AND COALESCE(p.readable,0)=0`
const RECORD_COLUMNS = 'ids.id, p.body, p.readable, u.body AS quarantined, b.body AS recovered'

function decodeStagedRecord(row: SqliteRow): AgentSessionRecord | undefined {
  const json = row.readable === 1 ? row.body : row.recovered
  const value: unknown = typeof json === 'string' ? JSON.parse(json) : undefined
  return isReadableAgentSessionStoreRecord(String(row.id), value)
    ? decodePersistedAgentSessionRecord(value).record
    : undefined
}

function stagedQuarantine(row: SqliteRow): { raw: unknown } | undefined {
  if (typeof row.quarantined === 'string') {
    const wrapper: unknown = JSON.parse(row.quarantined)
    return { raw: wrapper && typeof wrapper === 'object' && 'raw' in wrapper ? wrapper.raw : null }
  }
  if (row.readable === 0 && typeof row.body === 'string') {
    return { raw: JSON.parse(row.body) }
  }
  return undefined
}

function mergeLegacyRecordRows(
  db: Database.Database,
  stage: Database.Database,
  { generation, salvage, tabs }: LoadedRecordSnapshot,
  legacySessionTabIds: readonly string[],
  checkCancellation: () => void
): void {
  const wasDeleted = readLegacyDeletionAuthority(db)
  const sqlRecord = db.prepare('SELECT 1 FROM agent_session_records WHERE session_id=?')
  // A recorded SQL index is both the set of open tabs and proof of which SQL chats closed.
  const recordedSql = db
    .prepare('SELECT 1 FROM agent_session_store_meta WHERE key=?')
    .get(AGENT_SESSION_TABS_RECORDED)
  const savedPositions = new Map<string, number>()
  if (tabs === null && recordedSql) {
    for (const id of legacySessionTabIds) {
      checkCancellation()
      if (!savedPositions.has(id)) {
        savedPositions.set(id, savedPositions.size - legacySessionTabIds.length)
      }
    }
  }
  const insertTab = db.prepare(`INSERT INTO agent_session_tabs(tab_id,session_id,position)
    VALUES(?,?,?) ON CONFLICT(tab_id) DO NOTHING`)
  if (tabs !== null || savedPositions.size > 0) {
    stage.exec('CREATE TABLE sql_tab_sessions (id TEXT PRIMARY KEY)')
    const copySqlTab = stage.prepare(
      'INSERT INTO sql_tab_sessions VALUES(?) ON CONFLICT(id) DO NOTHING'
    )
    runJournalTransaction(stage, () => {
      for (const { session_id } of db
        .prepare('SELECT session_id FROM agent_session_tabs')
        .iterate()) {
        checkCancellation()
        copySqlTab.run(session_id)
      }
    })
  }
  const sqlTab =
    tabs !== null || savedPositions.size > 0
      ? stage.prepare('SELECT 1 FROM sql_tab_sessions WHERE id=?')
      : undefined
  if (tabs !== null) {
    const tabQuery =
      tabs === 'sessionTabs'
        ? 'SELECT session_id,tab_id FROM validated_tabs WHERE generation=? ORDER BY position'
        : 'SELECT session_id,tab_id FROM visible_tabs WHERE ? IS NOT NULL ORDER BY position'
    const tabCount =
      tabs === 'sessionTabs'
        ? stage
            .prepare('SELECT count(*) AS total FROM validated_tabs WHERE generation=?')
            .get(generation)
        : stage.prepare('SELECT count(*) AS total FROM visible_tabs').get()
    const record = stage.prepare(
      `SELECT ${RECORD_COLUMNS} FROM (SELECT ?3 AS id) ids ${RECORD_JOINS}`
    )
    let position = -Number(tabCount?.total)
    for (const { session_id, tab_id } of stage.prepare(tabQuery).iterate(generation)) {
      checkCancellation()
      const id = String(session_id)
      if (!sqlTab?.get(id) && !sqlRecord.get(id)) {
        const saved = record.get(generation, Number(salvage), id)
        if (!wasDeleted(id, saved && decodeStagedRecord(saved))) {
          insertTab.run(tab_id, id, position)
        }
      }
      position += 1
    }
    db.prepare(`INSERT INTO agent_session_store_meta(key,value) VALUES(?,'1')
      ON CONFLICT(key) DO NOTHING`).run(AGENT_SESSION_TABS_RECORDED)
  }

  const insertRecord = db.prepare(`INSERT INTO agent_session_records(session_id,record_json)
    VALUES(?,?) ON CONFLICT(session_id) DO NOTHING`)
  const insertOriginal = (id: string, body: string): void => {
    const { changes } = insertRecord.run(id, body)
    const position = savedPositions.get(id)
    if (changes && position !== undefined && !sqlTab?.get(id)) {
      insertTab.run(structuredAgentSessionTabId(id), id, position)
    }
  }
  const records = stage.prepare(`WITH ids(id) AS (
    SELECT key FROM legacy_rows WHERE generation=?1 AND section='records'
    UNION ALL SELECT u.key FROM legacy_rows u WHERE u.generation=?1 AND u.section='unusableRecords'
      AND NOT EXISTS(SELECT 1 FROM legacy_rows r WHERE r.generation=?1 AND r.section='records' AND r.key=u.key)
  ) SELECT ${RECORD_COLUMNS} FROM ids ${RECORD_JOINS}`)
  for (const row of records.iterate(generation, Number(salvage))) {
    checkCancellation()
    const id = String(row.id)
    const loaded = decodeStagedRecord(row)
    if (sqlRecord.get(id) || wasDeleted(id, loaded)) {
      continue
    }
    const setAside = stagedQuarantine(row)
    if (!loaded) {
      insertOriginal(id, JSON.stringify(setAside?.raw ?? null))
      continue
    }
    let record = generation === 'backup' ? withBackupFence(loaded) : loaded
    record = setAside ? withBackupFence(record, setAside) : record
    const encoded = encodeAgentSessionRecord({
      ...record,
      lease: withoutRetiredLeaseLatches(record.lease)
    })
    if (!isReadableAgentSessionStoreRecord(id, encoded)) {
      // Preserve unreadable bytes, but never publish a backup with a fence that was lost on encode.
      if (record !== loaded) {
        throw new JournalDamageError('the original chat record could not preserve its backup fence')
      }
      insertOriginal(id, JSON.stringify(encodeAgentSessionRecord(loaded)))
    } else {
      insertOriginal(id, JSON.stringify(encoded))
    }
  }
  const insertOperation = db.prepare(`INSERT INTO agent_session_operations(operation_key,row_json)
    VALUES(?,?) ON CONFLICT(operation_key) DO NOTHING`)
  const section = stage.prepare(
    'SELECT key,body FROM legacy_rows WHERE generation=? AND section=? ORDER BY rowid'
  )
  for (const { key, body } of section.iterate(generation, 'operations')) {
    checkCancellation()
    insertOperation.run(key, body)
  }
  const insertRetiredKey =
    db.prepare(`INSERT INTO agent_session_retired_claim_keys(key_id,retired_at)
    VALUES(?,?) ON CONFLICT(key_id) DO NOTHING`)
  for (const { body } of section.iterate(generation, 'retiredClaimKeys')) {
    checkCancellation()
    const { keyId, retiredAt } = JSON.parse(String(body))
    insertRetiredKey.run(keyId, retiredAt)
  }
}

export function importJournalLegacyRecordSnapshot(
  source: Database.Database,
  db: Database.Database,
  stage: Database.Database,
  loaded: JournalLegacyRecordSnapshot,
  hostId: string,
  legacySessionTabIds: readonly string[],
  checkCancellation: () => void
): void {
  checkCancellation()
  if (loaded && loaded.hostId !== hostId) {
    console.warn('[agent-session-journal] host-mismatch importing original chat records', {
      fileHostId: loaded.hostId,
      hostId
    })
  }
  if (loaded?.tabs === 'visibleSessionIds') {
    assignLegacyVisibleTabs(stage, loaded.generation, checkCancellation)
  }
  runJournalTransaction(db, () => {
    if (loaded) {
      mergeLegacyRecordRows(db, stage, loaded, legacySessionTabIds, checkCancellation)
    }
    for (const { session_id } of db
      .prepare(`SELECT r.session_id FROM agent_session_records r
      WHERE NOT EXISTS(SELECT 1 FROM agent_session_store_meta WHERE key=?||r.session_id)`)
      .iterate(journalLegacyChatRevisionKey(''))) {
      checkCancellation()
      const id = String(session_id)
      recordJournalLegacyChatRevision(db, id, journalLegacyChatRevision(source, id) ?? 'null')
    }
  })
}
