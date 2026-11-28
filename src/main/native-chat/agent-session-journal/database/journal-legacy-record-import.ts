import {
  isAgentSessionId,
  type AgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { nextAgentSessionFence } from '../../../../shared/agent-session/lifecycle/leases/agent-session-next-fence'
import { encodeAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/records/agent-session-record-stored-form'
import { sessionIdFromFileName } from '../../../ai-vault/parsing/session-scanner-accumulator'
import {
  AGENT_SESSION_TABS_RECORDED,
  withoutRetiredLeaseLatches
} from '../../../runtime/agent-session/records/agent-session-record-rows'
import { isReadableAgentSessionStoreRecord } from '../../../runtime/agent-session/records/agent-session-store-row-rules'
import type Database from '../../../sqlite/sync-database'
import { DeletedChats } from '../../chat-deletion/deleted-chats'
import { readDeletedChats } from '../journal-deleted-chats'
import { FORGOTTEN_CHAT_KEY } from '../journal-forgotten-chats'
import { JournalDamageError } from '../replay/journal-open-failure'
import { runJournalTransaction } from './journal-database'
import type { JournalLegacyRecordSnapshot } from './journal-legacy-record-file'
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

function mergeLegacyRecordRows(
  db: Database.Database,
  { state, fromBackup }: NonNullable<JournalLegacyRecordSnapshot['loaded']>
): void {
  const wasDeleted = readLegacyDeletionAuthority(db)
  const sqlRecord = db.prepare('SELECT 1 FROM agent_session_records WHERE session_id=?')
  const tabs = !fromBackup && state.sessionTabs ? state.sessionTabs.entries() : null
  if (tabs === null) {
    db.prepare('DELETE FROM agent_session_store_meta WHERE key=?').run(AGENT_SESSION_TABS_RECORDED)
  } else {
    const sqlTabs = new Set(
      db
        .prepare('SELECT session_id FROM agent_session_tabs')
        .all()
        .map(({ session_id }) => session_id)
    )
    const insert = db.prepare(`INSERT INTO agent_session_tabs(tab_id,session_id,position)
      VALUES(?,?,?) ON CONFLICT(tab_id) DO NOTHING`)
    for (const [position, [tabId, id]] of tabs.entries()) {
      if (!sqlTabs.has(id) && !sqlRecord.get(id) && !wasDeleted(id, state.records.get(id))) {
        insert.run(tabId, id, position - tabs.length)
      }
    }
    db.prepare(`INSERT INTO agent_session_store_meta(key,value) VALUES(?,'1')
      ON CONFLICT(key) DO NOTHING`).run(AGENT_SESSION_TABS_RECORDED)
  }

  const insertRecord = db.prepare(`INSERT INTO agent_session_records(session_id,record_json)
    VALUES(?,?) ON CONFLICT(session_id) DO NOTHING`)
  for (const [id, loaded] of state.records) {
    if (sqlRecord.get(id) || wasDeleted(id, loaded)) {
      continue
    }
    let record = fromBackup ? withBackupFence(loaded) : loaded
    if (state.unreadableRecords.has(id)) {
      record = withBackupFence(record, { raw: state.unreadableRecords.get(id) })
    }
    const encoded = encodeAgentSessionRecord({
      ...record,
      lease: withoutRetiredLeaseLatches(record.lease)
    })
    if (!isReadableAgentSessionStoreRecord(id, encoded)) {
      // Preserve unreadable bytes, but never publish a backup with a fence that was lost on encode.
      if (record !== loaded) {
        throw new JournalDamageError('the original chat record could not preserve its backup fence')
      }
      insertRecord.run(id, JSON.stringify(encodeAgentSessionRecord(loaded)))
    } else {
      insertRecord.run(id, JSON.stringify(encoded))
    }
  }
  for (const [id, raw] of state.unreadableRecords) {
    if (!state.records.has(id) && !sqlRecord.get(id) && !wasDeleted(id, undefined)) {
      insertRecord.run(id, JSON.stringify(raw ?? null))
    }
  }
  const insertOperation = db.prepare(`INSERT INTO agent_session_operations(operation_key,row_json)
    VALUES(?,?) ON CONFLICT(operation_key) DO NOTHING`)
  for (const [key, operation] of state.operations) {
    insertOperation.run(key, JSON.stringify(operation))
  }
  const insertRetiredKey =
    db.prepare(`INSERT INTO agent_session_retired_claim_keys(key_id,retired_at)
    VALUES(?,?) ON CONFLICT(key_id) DO NOTHING`)
  for (const { keyId, retiredAt } of state.retiredClaimKeys) {
    insertRetiredKey.run(keyId, retiredAt)
  }
}

export function importJournalLegacyRecordSnapshot(
  source: Database.Database,
  db: Database.Database,
  { loaded }: JournalLegacyRecordSnapshot,
  hostId: string
): void {
  if (loaded && loaded.state.hostId !== hostId) {
    console.warn('[agent-session-journal] host-mismatch importing original chat records', {
      fileHostId: loaded.state.hostId,
      hostId
    })
  }
  runJournalTransaction(db, () => {
    if (loaded) {
      mergeLegacyRecordRows(db, loaded)
    }
    for (const { session_id } of db
      .prepare(`SELECT r.session_id FROM agent_session_records r
      WHERE NOT EXISTS(SELECT 1 FROM agent_session_store_meta WHERE key=?||r.session_id)`)
      .all(journalLegacyChatRevisionKey(''))) {
      const id = String(session_id)
      recordJournalLegacyChatRevision(db, id, journalLegacyChatRevision(source, id) ?? 'null')
    }
  })
}
