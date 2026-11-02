import type {
  AgentJournalSnapshot,
  AgentJournalItemBody
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalHostDatabase } from './journal-host-database'
import type { ContextTransferHandoff, ContextTransferRecord } from './context-transfer-record'
import { exportContextTransfer } from './context-transfer-export'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type Database from '../../sqlite/sync-database'
import type { JournalRow } from './journal-row-schema'
import type { JournalReducerState } from './journal-reducer'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { isAgentSessionProviderContextBoundary } from '../../../shared/agent-session/agent-session-provider-context'
import { matchContextTransferEcho } from './context-transfer-echo'
import { contextTransferOwner, readContextTransfers } from './context-transfer-repository'
import { writeContextTransferJournalReceipts } from './context-transfer-journal-receipts'

const indexes = new WeakMap<Database.Database, Map<string, readonly ContextTransferRecord[]>>()
const owners = new WeakMap<Database.Database, Map<string, AgentSessionRecord | null>>()
const dirtyFacts = new WeakMap<Database.Database, Set<string>>()
const dirtyOwners = new WeakMap<Database.Database, Set<string>>()

export function contextTransferIndex(
  db: Database.Database,
  sessionId: string,
  load: () => ContextTransferRecord[]
): readonly ContextTransferRecord[] {
  let index = indexes.get(db)
  if (!index) {
    index = new Map()
    indexes.set(db, index)
  }
  let records = index.get(sessionId)
  if (!records) {
    // Frozen so derived lookups can be memoized by array identity.
    records = Object.freeze(load())
    index.set(sessionId, records)
  }
  return records
}

function markDirty(
  sets: WeakMap<Database.Database, Set<string>>,
  db: Database.Database,
  id: string
) {
  if (!db.isTransaction) {
    return
  }
  let changed = sets.get(db)
  if (!changed) {
    changed = new Set()
    sets.set(db, changed)
  }
  changed.add(id)
}

export function invalidateContextTransferIndex(db: Database.Database, sessionId: string): void {
  indexes.get(db)?.delete(sessionId)
  markDirty(dirtyFacts, db, sessionId)
}

/** Owner changes leave unchanged transfer facts decoded. */
export function invalidateContextTransferOwner(db: Database.Database, sessionId: string): void {
  owners.get(db)?.delete(sessionId)
  markDirty(dirtyOwners, db, sessionId)
}

function indexedOwner(db: Database.Database, sessionId: string) {
  let index = owners.get(db)
  if (!index) {
    index = new Map()
    owners.set(db, index)
  }
  if (!index.has(sessionId)) {
    index.set(sessionId, contextTransferOwner(db, sessionId))
  }
  return index.get(sessionId) ?? null
}

/** Transaction-local derivations are never retained after commit or rollback. */
export function finishContextTransferTransaction(db: Database.Database): void {
  for (const sessionId of dirtyFacts.get(db) ?? []) {
    indexes.get(db)?.delete(sessionId)
  }
  for (const sessionId of dirtyOwners.get(db) ?? []) {
    owners.get(db)?.delete(sessionId)
  }
  dirtyFacts.delete(db)
  dirtyOwners.delete(db)
}

export function normalizeContextTransferItem(input: {
  db: Database.Database
  sessionId: string
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  fence?: number
  itemBody: (id: string) => AgentJournalItemBody | null
  carries: (id: string) => readonly string[]
}) {
  if (
    input.body.kind !== 'message' ||
    !input.body.blocks.some(
      (block) => block.type === 'text' && block.text.includes('<orca_context_handoff id=')
    )
  ) {
    return null
  }
  return matchContextTransferEcho({
    ...input,
    records: readContextTransfers(input.db, input.sessionId),
    owner: () => indexedOwner(input.db, input.sessionId)
  })
}

/** Streamed revisions and ordinary output cannot change transfer facts. */
export function participateContextTransferJournal(
  db: Database.Database,
  previous: JournalReducerState,
  next: JournalReducerState,
  rows: readonly JournalRow[],
  at: number
): void {
  if (
    !rows.some(
      (row) =>
        row.kind === 'dispatch' ||
        (row.kind === 'item' &&
          row.body.kind === 'status' &&
          isAgentSessionProviderContextBoundary(row.body.contextClear))
    )
  ) {
    return
  }
  const records = readContextTransfers(db, next.sessionId)
  if (!records.length) {
    return
  }
  writeContextTransferJournalReceipts(db, previous, next, rows, at, records)
}

export function createJournalContextTransfer(input: {
  database: JournalHostDatabase
  sessionId: string
  snapshot: () => AgentJournalSnapshot
  canonicalItemId: (id: string) => string
  itemBody: (id: string) => AgentJournalItemBody | null
  carries: (id: string) => readonly string[]
}) {
  return {
    recoveryEcho: (
      identity: AgentJournalItemIdentity,
      body: AgentJournalItemBody,
      fence?: number
    ) =>
      normalizeContextTransferItem({
        db: input.database.db,
        sessionId: input.sessionId,
        identity,
        body,
        fence,
        itemBody: input.itemBody,
        carries: input.carries
      }),
    exportRecoveryContext: (handoff: ContextTransferHandoff) =>
      exportContextTransfer(
        input.database,
        input.sessionId,
        input.snapshot(),
        input.canonicalItemId,
        handoff
      )
  }
}
