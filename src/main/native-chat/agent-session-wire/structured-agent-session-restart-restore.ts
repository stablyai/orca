// What a restart owes a persisted session, and what it does NOT.
//
// It owes reconciliation — every lease loaded from disk names an owner from a process generation
// that no longer exists, and adjudicating that is startup's job. It owes an exit from any recovery
// stage the evidence now permits. And it owes the chat's tab and status row: Interrupted when a
// turn was open as its host stopped, else Done, from the record and the journal's saved open turn.
//
// It does not owe a replay. Reading every restored chat's history into memory made startup cost
// grow with everything ever said in every open tab. A chat's history is read when something opens
// it — a view, a send, owed mail — and that open settles what the gone generation left running
// (`structured-agent-session-conversation-open.ts`), then publishes the journal's own row over this
// one. Nor does it owe a provider child: a child exists because work asked for it.

import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import {
  readJournalRestFacts,
  type JournalRestFacts
} from '../agent-session-journal/journal-row-table'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

/** Lease probes are the slow part; journal facts are two index lookups per chat. */
const LEASE_RECONCILE_CONCURRENCY = 4
/** Index lookups are cheap, but hundreds of them in one task would still hold the UI's process. */
const LISTING_YIELD_EVERY = 32

/** A chat never written has nothing to show, and listing must not found a journal for it. */
const UNWRITTEN = Symbol('unwritten')

export type StructuredAgentSessionRestartListingDeps = {
  store: Pick<AgentSessionRecordStore, 'listRecords'>
  journalDatabase: Pick<JournalHostDatabase, 'db' | 'readOnly'>
  logger: StructuredAgentSessionLogger
  // Lease bookkeeping. Neither throws: listing grants no writer, so bookkeeping must not block it.
  /** Whether every lease on this host is settled. */
  reconcileAll: () => Promise<boolean>
  /** Whether this chat's lease is settled. */
  reconcile: (sessionId: string) => Promise<boolean>
  /** False when its store write failed; the next attach or send resolves it again. */
  resolveRecovery: (sessionId: string) => Promise<boolean>
  /** Chats the teardown resume marker says were working when their host stopped: what a chat
   *  saved before its journal kept an open turn is read as interrupted by. */
  readWorkingAtTeardown: () => Promise<ReadonlySet<string>>
  hasSession: (sessionId: string) => boolean
  /** A restored chat with a record. `rest` is null when no row is owed here: an open already
   *  published the journal's own, or the journal could not be read, whose first read says why. */
  onListed: (
    record: AgentSessionRecord,
    rest: (JournalRestFacts & { interrupted: boolean }) | null
  ) => void
}

/** Lists the restored chats in `sessionIds`' order (every record when absent), reading no history. */
export async function listStructuredAgentSessionsOnRestart(
  input: StructuredAgentSessionRestartListingDeps,
  sessionIds?: readonly string[]
): Promise<void> {
  const order = sessionIds ? new Map(sessionIds.map((id, index) => [id, index])) : null
  const records = input.store
    .listRecords()
    .filter((record) => !order || order.has(record.sessionId))
  if (order) {
    records.sort((left, right) => order.get(left.sessionId)! - order.get(right.sessionId)!)
  }
  if (records.length === 0) {
    return
  }
  // One whole-host check for the pass, which also retries a startup pass that failed. After a
  // failure, per-chat retries only hit the same store again; each chat's own action reconciles it.
  let settled = await input.reconcileAll()
  await mapWithConcurrency(records, LEASE_RECONCILE_CONCURRENCY, async ({ sessionId }) => {
    // A session latched in recovery exits here at startup, without waiting for a client.
    if (
      settled &&
      !((await input.reconcile(sessionId)) && (await input.resolveRecovery(sessionId)))
    ) {
      settled = false
    }
  })
  const workingAtTeardown = await input.readWorkingAtTeardown()
  // In the restore's order, so the tabs keep the order they were saved in.
  for (const [index, record] of records.entries()) {
    if (index % LISTING_YIELD_EVERY === 0) {
      await yieldToEventLoop()
    }
    // A read or a send mid-restore already opened it, and published the journal's own row.
    const rest = input.hasSession(record.sessionId)
      ? null
      : readRest(input, record.sessionId, workingAtTeardown)
    if (rest !== UNWRITTEN) {
      input.onListed(record, rest)
    }
  }
}

/** The chat's rest facts; null when they cannot be read, which keeps its tab for a read to explain. */
function readRest(
  input: StructuredAgentSessionRestartListingDeps,
  sessionId: string,
  workingAtTeardown: ReadonlySet<string>
): (JournalRestFacts & { interrupted: boolean }) | null | typeof UNWRITTEN {
  // A newer Orca's database: its chats are only that build's to read.
  if (input.journalDatabase.readOnly) {
    return null
  }
  try {
    const rest = readJournalRestFacts(input.journalDatabase.db, sessionId)
    return rest
      ? { ...rest, interrupted: rest.openTurn !== null || workingAtTeardown.has(sessionId) }
      : UNWRITTEN
  } catch (error) {
    input.logger.warn('reading a chat at startup failed', {
      scope: 'restart-restore',
      sessionId,
      error
    })
    return null
  }
}
