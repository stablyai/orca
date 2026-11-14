import { journalForkStageHeld } from './journal-fork-stage-state'
import { pruneJournalWriterOperations } from './journal-writer-operation-expiry'
import { copyAgentSessionStoreCache } from '../../runtime/agent-session/records/agent-session-store-cache'
import { journalDomainPublicCursor } from './journal-domain-context-replacement'
import {
  loadAgentSessionStoreTabs,
  loadAgentSessionStoreRecordRow
} from '../../runtime/agent-session/records/agent-session-record-rows'
import type Database from '../../sqlite/sync-database'
import { encodeAgentSessionRecord } from '../../../shared/agent-session/lifecycle/records/agent-session-record-stored-form'
import {
  applyAgentSessionStoreMutation,
  agentSessionStoreMutationKeys,
  type AgentSessionStoreMutation
} from '../../runtime/agent-session/records/agent-session-store-mutation'
import {
  agentSessionStoreRowChanges,
  type AgentSessionStoreRowWrites
} from './journal-writer-store-row-changes'
import type { AgentSessionStoreState } from '../../runtime/agent-session/records/agent-session-store-state'
import { isReadableAgentSessionStoreOperation } from '../../runtime/agent-session/records/agent-session-store-row-rules'
import { JournalSqlScope } from './journal-sql-scope'
import { JournalSqlStatusContext } from './journal-sql-status-context'
import { readJournalSqlUsageLimitContinueIdentity } from './journal-sql-status-cuts'
import {
  attributeAgentSessionRuntimeRecord,
  type AgentSessionRuntimeFacts
} from '../../runtime/agent-session/agent-session-runtime-attribution'

export function emptyJournalWriterStoreRows(): AgentSessionStoreRowWrites {
  return {
    records: { upsert: [], remove: [] },
    operations: { upsert: [], remove: [] },
    retiredClaimKeys: null,
    sessionTabs: null
  }
}

/** No row draft survives this source group; SQLite owns composition and rollback. */
export function resolveJournalWriterStoreMutation(
  db: Database.Database,
  mutation: AgentSessionStoreMutation,
  at: number | undefined,
  planMode?: 'default' | 'plan',
  runtime?: AgentSessionRuntimeFacts
): {
  writes: AgentSessionStoreRowWrites
  acknowledged: AgentSessionStoreRowWrites
  value: unknown
  changed: boolean
} {
  if (
    mutation.kind === 'command' &&
    mutation.command.kind === 'found' &&
    journalForkStageHeld(db, mutation.command.request.sessionId)
  ) {
    throw new Error('fork stage owns this child founding')
  }
  const state: AgentSessionStoreState = {
    records: new Map(),
    operations: new Map(),
    unreadableRecords: new Map(),
    retiredClaimKeys: [],
    sessionTabs: null
  }
  const touched = emptyJournalWriterStoreRows()
  const identity = agentSessionStoreMutationKeys(mutation)
  if (identity.tabs) {
    state.sessionTabs = loadAgentSessionStoreTabs(db)
  }
  const recordIds = [
    ...identity.recordIds,
    ...(state.sessionTabs === null ? (identity.legacyRecordIds ?? []) : [])
  ]
  const extraPredicates: string[] = []
  if (identity.adoptedNativeId !== undefined) {
    extraPredicates.push('adopted_native_id = ?')
  }
  if (identity.missingPermission) {
    extraPredicates.push(`CASE WHEN json_valid(record_json)
      THEN json_type(record_json,'$.permissionMode') IS NULL ELSE 0 END`)
  }
  for (const row of db
    .prepare(`SELECT session_id,record_json FROM agent_session_records
      WHERE session_id IN (SELECT value FROM json_each(?))
        ${extraPredicates.map((predicate) => `OR (${predicate})`).join(' ')} ORDER BY rowid`)
    .all(
      JSON.stringify(recordIds),
      ...(identity.adoptedNativeId !== undefined ? [identity.adoptedNativeId] : [])
    )) {
    loadAgentSessionStoreRecordRow(state, String(row.session_id), String(row.record_json), false)
  }
  const loadRecord = (id: string) => {
    const row = db
      .prepare('SELECT record_json FROM agent_session_records WHERE session_id=?')
      .get(id)
    if (!row) {
      return
    }
    loadAgentSessionStoreRecordRow(state, id, String(row.record_json), false)
  }
  if (identity.pruneAt !== undefined) {
    touched.operations.remove.push(...pruneJournalWriterOperations(db, identity.pruneAt))
  }
  const operationKeys =
    identity.allCallers && identity.operationId !== undefined
      ? db
          .prepare('SELECT operation_key FROM agent_session_operations WHERE operation_id=?')
          .all(identity.operationId)
          .map((row) => String(row.operation_key))
      : []
  if (identity.operationKey && !operationKeys.includes(identity.operationKey)) {
    operationKeys.push(identity.operationKey)
  }
  for (const key of operationKeys) {
    const row = db
      .prepare('SELECT row_json FROM agent_session_operations WHERE operation_key=?')
      .get(key)
    if (!row) {
      continue
    }
    const saved: unknown = JSON.parse(String(row.row_json))
    if (!isReadableAgentSessionStoreOperation(key, saved)) {
      throw new Error('agent_session_store_operation_unreadable')
    }
    state.operations.set(key, saved)
    if (
      mutation.kind === 'command' &&
      (mutation.command.kind === 'reserve' || mutation.command.kind === 'found') &&
      saved.outcome.status === 'succeeded' &&
      !identity.recordIds.includes(saved.outcome.sessionId)
    ) {
      identity.recordIds.push(saved.outcome.sessionId)
      loadRecord(saved.outcome.sessionId)
    }
  }
  const draft = copyAgentSessionStoreCache(state)
  const action = mutation.kind === 'operation' ? mutation.record : undefined
  const head =
    mutation.kind === 'rewind-complete' ||
    (action?.action.kind === 'stop-continue' && action.action.enabled)
      ? db
          .prepare(
            'SELECT epoch,last_sequence FROM journal_chat_state WHERE session_id=? AND epoch IS NOT NULL'
          )
          .get(mutation.kind === 'rewind-complete' ? mutation.sessionId : (action?.sessionId ?? ''))
      : undefined
  const continueCut =
    head && (action || mutation.kind === 'rewind-complete')
      ? readJournalSqlUsageLimitContinueIdentity(
          new JournalSqlStatusContext(
            new JournalSqlScope(
              db,
              mutation.kind === 'rewind-complete' ? mutation.sessionId : (action?.sessionId ?? ''),
              String(head.epoch)
            )
          )
        )
      : undefined
  const sleepingWithPendingInput =
    mutation.kind === 'record' &&
    mutation.command.kind === 'sleep' &&
    !!db
      .prepare(`SELECT 1 FROM journal_submission_attempts AS input
    JOIN journal_chat_state AS chat ON chat.session_id=input.session_id AND chat.epoch=input.epoch
    WHERE input.session_id=? AND input.current=1 AND input.dispatch_state='pending' LIMIT 1`)
      .get(mutation.sessionId)
  let value = sleepingWithPendingInput
    ? null
    : applyAgentSessionStoreMutation(draft, mutation, at, {
        planMode,
        continueCut,
        cursor:
          mutation.kind === 'rewind-complete' && head
            ? journalDomainPublicCursor(
                db,
                { sessionId: mutation.sessionId, epoch: String(head.epoch) },
                Number(head.last_sequence)
              )
            : undefined
      })
  if (runtime) {
    for (const [id, after] of draft.records) {
      const before = state.records.get(id)
      const attributed = attributeAgentSessionRuntimeRecord(
        before,
        after,
        runtime.ends,
        runtime.incarnation
      )
      draft.records.set(id, attributed)
      if (value instanceof Map && value.get(id) === after) {
        value.set(id, attributed)
      }
      if (Array.isArray(value)) {
        value = value.map((entry) => (entry === after ? attributed : entry))
      }
      if (value === after) {
        value = attributed
      } else if (
        value &&
        typeof value === 'object' &&
        'record' in value &&
        value.record === after
      ) {
        value = { ...value, record: attributed }
      }
    }
  }
  const changed = agentSessionStoreRowChanges(state, draft)
  const writes = changed ?? emptyJournalWriterStoreRows()
  const acknowledged = {
    ...writes,
    records: { upsert: [...writes.records.upsert], remove: [...writes.records.remove] },
    operations: {
      upsert: [...writes.operations.upsert],
      remove: [...writes.operations.remove, ...touched.operations.remove].filter(
        (key) => !writes.operations.upsert.some(([id]) => id === key)
      )
    }
  }
  for (const id of identity.recordIds) {
    if (acknowledged.records.upsert.some(([key]) => key === id)) {
      continue
    }
    const record = draft.records.get(id)
    if (record) {
      acknowledged.records.upsert.push([id, JSON.stringify(encodeAgentSessionRecord(record))])
    } else if (!draft.unreadableRecords.has(id)) {
      acknowledged.records.remove.push(id)
    }
  }
  for (const key of operationKeys) {
    if (acknowledged.operations.upsert.some(([id]) => id === key)) {
      continue
    }
    const row = draft.operations.get(key)
    if (row) {
      acknowledged.operations.upsert.push([key, JSON.stringify(row)])
    } else {
      acknowledged.operations.remove.push(key)
    }
  }
  return {
    writes,
    acknowledged,
    value,
    changed: changed !== null || touched.operations.remove.length > 0
  }
}
