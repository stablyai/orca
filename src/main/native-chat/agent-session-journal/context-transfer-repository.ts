import {
  contextTransferIndex,
  invalidateContextTransferIndex,
  recordContextTransferWrite
} from './journal-context-transfer'
import {
  contextTransferLookup,
  deriveContextTransferState,
  contextTransferDelivered
} from './context-transfer-state'
export { currentContextTransferTarget, contextTransferDelivered } from './context-transfer-state'
import type { JournalHostDatabase } from './journal-host-database'
import { isPersistedAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { decodePersistedAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record-stored-form'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { journalOpenRefusalError } from './journal-open-failure'
import { AgentSessionJournalError } from './journal-write-guards'
import { contextTransferRecordSchema, type ContextTransferRecord } from './context-transfer-record'

export const CONTEXT_TRANSFER_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS agent_session_context_transfers (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, handoff_id TEXT NOT NULL,
  kind TEXT NOT NULL, format INTEGER NOT NULL, record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_session_context_transfer_owner
  ON agent_session_context_transfers(session_id, handoff_id, kind);
`

function unreadable(): never {
  throw journalOpenRefusalError(
    new AgentSessionJournalError(
      'journal_read_only',
      'Saved context transfer cannot be read by this Orca'
    )
  )
}

export function readContextTransfers(
  db: Database.Database,
  sessionId: string
): readonly ContextTransferRecord[] {
  return contextTransferIndex(db, sessionId, () => loadContextTransfers(db, sessionId))
}

function loadContextTransfers(db: Database.Database, sessionId: string): ContextTransferRecord[] {
  const rows = db
    .prepare(
      'SELECT id, session_id, handoff_id, kind, format, record_json FROM agent_session_context_transfers WHERE session_id = ? ORDER BY rowid'
    )
    .all(sessionId)
  return rows.map((row) => {
    if (row.format !== 1 || typeof row.record_json !== 'string') {
      return unreadable()
    }
    let value: unknown
    try {
      value = JSON.parse(row.record_json)
    } catch {
      return unreadable()
    }
    const decoded = contextTransferRecordSchema.safeParse(value)
    if (!decoded.success) {
      return unreadable()
    }
    const record = decoded.data
    if (
      record.id !== row.id ||
      record.sessionId !== row.session_id ||
      record.handoffId !== row.handoff_id ||
      record.kind !== row.kind
    ) {
      return unreadable()
    }
    return record
  })
}

export function writeContextTransfer(db: Database.Database, record: ContextTransferRecord): void {
  contextTransferRecordSchema.parse(record)
  const records = readContextTransfers(db, record.sessionId)
  const lookup = contextTransferLookup(records)
  const previous = lookup.byId.get(record.id)
  if (previous && (previous.kind !== record.kind || previous.handoffId !== record.handoffId)) {
    throw new Error('Context transfer identity changed')
  }
  if (previous?.kind === 'handoff' && JSON.stringify(previous) !== JSON.stringify(record)) {
    throw new Error('Frozen context changed')
  }
  if (
    previous?.kind === 'delivery' &&
    record.kind === 'delivery' &&
    JSON.stringify(previous.selection) !== JSON.stringify(record.selection)
  ) {
    throw new Error('Frozen delivery changed')
  }
  if (record.kind !== 'handoff' && !lookup.handoffs.has(record.handoffId)) {
    throw new Error('Context transfer has no source')
  }
  if (record.kind === 'target') {
    if (previous?.kind === 'target') {
      const {
        targetLink: oldLink,
        acquisitionGeneration: oldGeneration,
        firstInputId: oldInput,
        ...oldFixed
      } = previous
      const {
        targetLink: nextLink,
        acquisitionGeneration: nextGeneration,
        firstInputId: nextInput,
        ...nextFixed
      } = record
      if (
        !isDeepStrictEqual(oldFixed, nextFixed) ||
        (oldLink !== null && !isDeepStrictEqual(oldLink, nextLink)) ||
        (oldGeneration !== null && oldGeneration !== nextGeneration) ||
        (oldInput !== null && oldInput !== nextInput)
      ) {
        throw new Error('Context target facts changed')
      }
    } else {
      const owner = contextTransferOwner(db, record.sessionId)
      const state = deriveContextTransferState(records, owner?.providerHandleChain ?? [])
      const current = state.kind === 'none' ? undefined : state.target
      const handoff = lookup.handoffs.get(record.handoffId)
      const sameHandoff = current?.handoffId === record.handoffId
      const successor = current && handoff?.supersedesHandoffId === current.handoffId
      if ((sameHandoff || successor ? current?.id : null) !== record.predecessorTargetId) {
        throw new Error('Context target predecessor changed')
      }
      if (
        current &&
        !sameHandoff &&
        (!successor || !contextTransferDelivered(records, current.id))
      ) {
        throw new Error('An unfinished context source already owns this conversation')
      }
    }
    if ((record.targetLink === null) !== (record.acquisitionGeneration === null)) {
      throw new Error('Context target publication is incomplete')
    }
  }
  if (record.kind === 'delivery') {
    const target = lookup.targets.get(record.targetId)
    if (!target || target.handoffId !== record.handoffId || !target.targetLink) {
      throw new Error('Context delivery has no published target')
    }
    if (previous?.kind === 'delivery') {
      const { writeStartedAt: oldStarted, outcome: oldOutcome, ...oldFixed } = previous
      const { writeStartedAt: nextStarted, outcome: nextOutcome, ...nextFixed } = record
      if (
        !isDeepStrictEqual(oldFixed, nextFixed) ||
        (oldStarted !== undefined && oldStarted !== nextStarted) ||
        (oldOutcome && oldOutcome.kind !== 'unknown' && !isDeepStrictEqual(oldOutcome, nextOutcome))
      ) {
        throw new Error('Context delivery facts changed')
      }
    }
  }
  db.prepare(`INSERT INTO agent_session_context_transfers (id,session_id,handoff_id,kind,format,record_json)
    VALUES (?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json`).run(
    record.id,
    record.sessionId,
    record.handoffId,
    record.kind,
    JSON.stringify(record)
  )
  recordContextTransferWrite(db, record)
}

export function closeContextTransfers(
  db: Database.Database,
  sessionId: string,
  commandId: string,
  cause: 'context-clear' | 'rewind',
  at: number,
  successorHandoffId?: string
): void {
  // Copied: each closure write removes its handoff from the open set.
  for (const handoffId of Array.from(
    contextTransferLookup(readContextTransfers(db, sessionId)).openHandoffs
  )) {
    writeContextTransfer(db, {
      kind: 'closure',
      id: randomUUID(),
      sessionId,
      handoffId,
      commandId,
      cause,
      at,
      ...(successorHandoffId ? { successorHandoffId } : {})
    })
  }
}

export class ContextTransferRepository {
  constructor(
    private readonly database: JournalHostDatabase,
    readonly sessionId: string
  ) {}
  reopen(): void {
    invalidateContextTransferIndex(this.database.db, this.sessionId)
    this.read()
  }
  read(): readonly ContextTransferRecord[] {
    return readContextTransfers(this.database.db, this.sessionId)
  }
  commit(run: (db: Database.Database) => void): void {
    if (this.database.readOnly) {
      return unreadable()
    }
    this.database.transaction((db) => {
      readContextTransfers(db, this.sessionId)
      run(db)
    })
  }
  write(record: ContextTransferRecord): void {
    this.commit((db) => writeContextTransfer(db, record))
  }
}

export function contextTransferOwner(db: Database.Database, sessionId: string) {
  const row = db
    .prepare('SELECT record_json FROM agent_session_records WHERE session_id = ?')
    .get(sessionId)
  if (typeof row?.record_json !== 'string') {
    return null
  }
  let value: unknown
  try {
    value = JSON.parse(row.record_json)
  } catch {
    return null
  }
  if (!isPersistedAgentSessionRecord(value)) {
    return null
  }
  return decodePersistedAgentSessionRecord(value).record
}
