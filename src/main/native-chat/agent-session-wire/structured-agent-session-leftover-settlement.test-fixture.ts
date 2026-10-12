// A dead generation's leftover work, for the leftover-settlement tests: a child that leaves a running
// turn (and what else a test asks for), an exit whose settlement the database refuses, and the
// database instruments the tests read.

import { expect, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import {
  codexSubagentGroupBody,
  codexSubagentGroupIdentity
} from '../../codex/codex-subagent-roster'
import {
  liveTestJournalRows,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import type Database from '../../sqlite/sync-database'
import { JournalRowWriter } from '../agent-session-journal/journal-row-writer'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import { hostStructuredAgentSessionCurrentWork } from './structured-agent-session-host-current-work'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { retryIdle, retryOwes } from './structured-agent-session-retry.test-fixture'

export const TURN: AgentJournalItemIdentity = {
  provider: 'codex',
  threadId: THREAD,
  turnId: 'unfinished',
  ordinal: 1
}
export const TURN_KEY = agentJournalItemKey(TURN)
const IN_TURN = { kind: 'turn' as const, turnItemId: TURN_KEY }
export const APPROVAL: AgentJournalItemIdentity = { ...TURN, ordinal: 2 }
export const TOOL: AgentJournalItemIdentity = { ...TURN, ordinal: 3 }
export const REASONING: AgentJournalItemIdentity = { ...TURN, ordinal: 4 }
export const ROSTER_GROUP = `${THREAD}:unfinished`
export const TASK: AgentJournalItemIdentity = {
  provider: 'orca',
  clientMessageId: 'claude-background-task:task-1'
}
/** Refuses every row a settlement writes: its rows are all `recovered`. */
export const REJECT_RECOVERED_ROWS = `
  CREATE TEMP TRIGGER reject_recovered BEFORE INSERT ON journal_rows
  WHEN json_extract(NEW.row_json, '$.recovered') = 1
  BEGIN SELECT RAISE(ABORT, 'temporary storage failure'); END;
`

/** The live child leaves a running turn, and what else the test asks for, in the journal. */
export async function leaveUnfinishedWork(
  current: QueuedMessageTestRig,
  options: { prompt?: true; everything?: true } = {}
): Promise<void> {
  const events = current.providerEvents()
  events.appendItem(
    TURN,
    { kind: 'turn', turnId: 'unfinished', state: 'running' },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  if (options.prompt || options.everything) {
    events.appendItem(
      APPROVAL,
      {
        kind: 'approval',
        title: 'Run command?',
        detail: null,
        options: [{ id: 'yes', label: 'Allow' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      { turnScope: IN_TURN }
    )
  }
  if (options.everything) {
    events.appendItem(
      TOOL,
      { kind: 'tool-call', name: 'shell', input: { command: 'pnpm test' }, state: 'running' },
      { turnScope: IN_TURN }
    )
    events.appendItem(
      REASONING,
      {
        kind: 'message',
        role: 'assistant',
        state: 'running',
        blocks: [{ type: 'text', text: 'thinking' }]
      },
      { turnScope: IN_TURN }
    )
    events.appendItem(
      codexSubagentGroupIdentity(ROSTER_GROUP),
      codexSubagentGroupBody(ROSTER_GROUP, [
        { id: 'a', label: 'read', state: 'working', startedAt: 10 }
      ]),
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    events.appendItem(
      TASK,
      {
        kind: 'message',
        role: 'system',
        blocks: [
          { type: 'text', text: 'Started background command "sleep 20"' },
          {
            type: 'background-task',
            taskId: 'task-1',
            kind: 'command',
            label: 'sleep 20',
            state: 'working',
            startedAt: 10
          }
        ]
      },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  await current.host.flushStreamedEvents(SESSION)
}

/** The child dies on its own while the database refuses every settlement row: the exit releases
 *  its lease (proof written, fence moved) and its work stays saved as running. The host's
 *  retry is left backing off. */
export async function exitWhileSettlementFails(current: QueuedMessageTestRig) {
  const context = current.host.collaboratorsForTests()
  const session = context.sessions.get(SESSION)
  const child = session?.child
  if (!session || !child?.generation) {
    throw new Error('expected the original child')
  }
  const database = openTestJournalHostDatabase(current.root)
  const before = liveTestJournalRows(database.db, SESSION)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  database.db.exec(REJECT_RECOVERED_ROWS)
  await current.host.handleAdapterEvent({
    type: 'ended',
    sessionId: SESSION,
    cause: 'unexpected-exit',
    reason: 'observed exit',
    fence: child.fence,
    acquisitionGeneration: child.generation
  })
  await context.serialize(SESSION, async () => {})
  // The retry's first visit waited for the exit's lane; it fails too, and backs off.
  await context.reconciliation.attempted(SESSION)
  expect(session.child).toBeNull()
  expect(current.store.getRecord(SESSION)?.lease).toMatchObject({
    claimStatus: 'released',
    runtimeFence: child.fence + 1,
    deathEvidence: { kind: 'exit-observed', ownerFence: child.fence }
  })
  expect(liveTestJournalRows(database.db, SESSION)).toEqual(before)
  return { session, database, deadFence: child.fence }
}

/** The child exits on its own with nothing refused. */
export async function exitChild(current: QueuedMessageTestRig): Promise<void> {
  const context = current.host.collaboratorsForTests()
  const child = context.sessions.get(SESSION)?.child
  if (!child?.generation) {
    throw new Error('expected a child')
  }
  await current.host.handleAdapterEvent({
    type: 'ended',
    sessionId: SESSION,
    cause: 'unexpected-exit',
    reason: 'observed exit',
    fence: child.fence,
    acquisitionGeneration: child.generation
  })
  await context.serialize(SESSION, async () => {})
}

/** A person's ordinary text send from the composer, with queueing on, at the current fence. */
export function sendText(current: QueuedMessageTestRig, text: string) {
  const fence = current.store.getRecord(SESSION)?.lease.runtimeFence
  if (fence === undefined) {
    throw new Error('expected the record')
  }
  const body = hostTestMessage(text)
  const clientOperationId = hostTestOperationId()
  const fields = { body, delivery: 'queue-if-active' as const }
  const result = current.host.send(CALLER, {
    ...fields,
    userSend: true,
    envelope: {
      ...current.envelope(fields, 'agentSession.send', clientOperationId),
      expectedRuntimeFence: fence
    }
  })
  return { clientOperationId, result }
}

export function currentJournal(current: QueuedMessageTestRig) {
  const journal = current.host.collaboratorsForTests().sessions.get(SESSION)?.journal
  if (!journal) {
    throw new Error('expected the open conversation')
  }
  return journal
}

/** The host's projection of the chat's current work, as every host reader asks it. */
export function currentWork(current: QueuedMessageTestRig): StructuredAgentSessionCurrentWork {
  const work = hostStructuredAgentSessionCurrentWork(
    { store: current.store, sessions: current.host.collaboratorsForTests().sessions },
    SESSION
  )
  if (!work) {
    throw new Error('expected the open conversation')
  }
  return work
}

export function turnState(current: QueuedMessageTestRig): string | undefined {
  return readAgentJournalTurn(currentJournal(current).itemBody(TURN_KEY) ?? undefined)?.state
}

/** The rows settlements wrote: each is `recovered`. */
export function recoveredRows(db: Database.Database) {
  return liveTestJournalRows(db, SESSION).filter((row) => {
    const parsed: unknown = JSON.parse(row.rowJson)
    return typeof parsed === 'object' && parsed !== null && 'recovered' in parsed
  })
}

export function rowFence(row: { rowJson: string }): number {
  const parsed: unknown = JSON.parse(row.rowJson)
  return typeof parsed === 'object' && parsed !== null && 'fence' in parsed
    ? Number(parsed.fence)
    : Number.NaN
}

/** Each journal transaction that wrote settlement rows, by the rows it wrote: one entry per
 *  commit. */
export function watchSettlementCommits(): () => JournalRow[][] {
  const writes = vi.spyOn(JournalRowWriter.prototype, 'writeRows')
  return () =>
    writes.mock.results.flatMap((result) =>
      result.type === 'return' && result.value.some((row) => row.recovered === true)
        ? [result.value]
        : []
    )
}

/** Once the host's retry owes the chat nothing. */
export function reconciled(current: QueuedMessageTestRig, timeout = 10_000): Promise<void> {
  return vi.waitFor(
    () =>
      expect(retryOwes(current.host.collaboratorsForTests().reconciliation, SESSION)).toBe(false),
    { timeout }
  )
}

/** Logs every INSERT, UPDATE and DELETE on every table of the file, from this connection on. */
export function logEveryWrite(db: Database.Database): () => string[] {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => String(row.name))
  db.exec('CREATE TEMP TABLE test_write_log (entry TEXT)')
  for (const table of tables) {
    for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
      db.exec(`CREATE TEMP TRIGGER test_log_${op}_${table} AFTER ${op} ON main.${table}
        BEGIN INSERT INTO test_write_log VALUES ('${op} ${table}'); END;`)
    }
  }
  return () =>
    db
      .prepare('SELECT entry FROM test_write_log')
      .all()
      .map((row) => String(row.entry))
}

/** Startup as the runtime runs it, on any host: the restart reconcile, then the scan of every chat
 *  it begins, with no stored mark of what is owed, until the host's retry is idle. */
export async function startUpHost(
  host: Pick<
    StructuredAgentSessionHost,
    'reconcileRestartLeases' | 'startupSettled' | 'collaboratorsForTests'
  >
): Promise<void> {
  await host.reconcileRestartLeases()
  await host.startupSettled()
  await retryIdle(host.collaboratorsForTests().reconciliation, SESSION)
}

/** Startup as the runtime runs it: the restart reconcile, then the scan of every chat it begins,
 *  until the host's retry owes it nothing. */
export async function startUp(
  current: QueuedMessageTestRig,
  host: Pick<StructuredAgentSessionHost, 'reconcileRestartLeases' | 'startupSettled'> = current.host
): Promise<void> {
  await host.reconcileRestartLeases()
  await host.startupSettled()
  await reconciled(current)
}
