import { deriveContextTransferState } from './context-transfer-state'
export { currentContextTransferTarget, contextTransferDelivered } from './context-transfer-state'
import type { JournalHostDatabase } from './journal-host-database'
import { isPersistedAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { decodePersistedAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record-stored-form'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { contextTransferRecordSchema, type ContextTransferRecord } from './context-transfer-record'
import {
  CONTEXT_TRANSFER_INDEX_SQL,
  ContextTransferFacts,
  decodeContextTransferRow,
  forgetContextTransferRow,
  unreadableContextTransfer
} from './context-transfer-facts'

export const CONTEXT_TRANSFER_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS agent_session_context_transfers (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, handoff_id TEXT NOT NULL,
  kind TEXT NOT NULL, format INTEGER NOT NULL, record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_session_context_transfer_owner
  ON agent_session_context_transfers(session_id, handoff_id, kind);
${CONTEXT_TRANSFER_INDEX_SQL}`

/** Databases written by earlier builds of this table gain its lookup indexes; without them queries only slow. */
export function ensureContextTransferIndexes(db: Database.Database): void {
  try {
    db.exec(CONTEXT_TRANSFER_INDEX_SQL)
  } catch (error) {
    console.warn('[agent-session-journal] context transfer indexes could not be created', error)
  }
}

/** Every decoded row of one chat, in write order; for inspection, never a decision path. */
export function readContextTransfers(
  db: Database.Database,
  sessionId: string
): readonly ContextTransferRecord[] {
  new ContextTransferFacts(db, sessionId).checkFormat()
  return db
    .prepare(
      'SELECT id, session_id, handoff_id, kind, format, record_json FROM agent_session_context_transfers WHERE session_id = ? ORDER BY rowid'
    )
    .all(sessionId)
    .map(decodeContextTransferRow)
}

export function writeContextTransfer(db: Database.Database, record: ContextTransferRecord): void {
  contextTransferRecordSchema.parse(record)
  const facts = new ContextTransferFacts(db, record.sessionId)
  const owned = db
    .prepare('SELECT session_id FROM agent_session_context_transfers WHERE id = ?')
    .get(record.id)
  const previous = facts.record(record.id)
  if (
    (owned && owned.session_id !== record.sessionId) ||
    (previous && (previous.kind !== record.kind || previous.handoffId !== record.handoffId))
  ) {
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
  if (record.kind !== 'handoff' && !facts.handoff(record.handoffId)) {
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
      const state = deriveContextTransferState(facts, owner?.providerHandleChain ?? [])
      const current = state.kind === 'none' ? undefined : state.target
      const handoff = facts.handoff(record.handoffId)
      const sameHandoff = current?.handoffId === record.handoffId
      const successor = current && handoff?.supersedesHandoffId === current.handoffId
      if ((sameHandoff || successor ? current?.id : null) !== record.predecessorTargetId) {
        throw new Error('Context target predecessor changed')
      }
      if (current && !sameHandoff && (!successor || !facts.delivered(current.id))) {
        throw new Error('An unfinished context source already owns this conversation')
      }
    }
    if ((record.targetLink === null) !== (record.acquisitionGeneration === null)) {
      throw new Error('Context target publication is incomplete')
    }
  }
  if (record.kind === 'delivery') {
    const target = facts.target(record.targetId)
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
  forgetContextTransferRow(db, record.id)
}

export function closeContextTransfers(
  db: Database.Database,
  sessionId: string,
  commandId: string,
  cause: 'context-clear' | 'rewind',
  at: number,
  successorHandoffId?: string
): void {
  // Listed before writing: each closure moves the newest-closure boundary past the rest.
  for (const handoffId of new ContextTransferFacts(db, sessionId).openHandoffs()) {
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
  /** Opening refuses a chat holding rows in a format this build doesn't write. */
  reopen(): void {
    this.facts().checkFormat()
  }
  facts(): ContextTransferFacts {
    return new ContextTransferFacts(this.database.db, this.sessionId)
  }
  read(): readonly ContextTransferRecord[] {
    return readContextTransfers(this.database.db, this.sessionId)
  }
  commit(run: (db: Database.Database) => void): void {
    if (this.database.readOnly) {
      return unreadableContextTransfer()
    }
    this.database.transaction(run)
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
