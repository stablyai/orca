// A dead generation's leftover work, for the current-work tests: a child that leaves a running
// turn (and a prompt, when asked), and an exit whose settlement the database refuses.

import { expect, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import {
  liveTestJournalRows,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
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

export const TURN: AgentJournalItemIdentity = {
  provider: 'codex',
  threadId: THREAD,
  turnId: 'unfinished',
  ordinal: 1
}
export const TURN_KEY = agentJournalItemKey(TURN)
const IN_TURN = { kind: 'turn' as const, turnItemId: TURN_KEY }
export const APPROVAL: AgentJournalItemIdentity = { ...TURN, ordinal: 2 }
/** Refuses every row a settlement writes: its rows are all `recovered`. */
export const REJECT_RECOVERED_ROWS = `
  CREATE TEMP TRIGGER reject_recovered BEFORE INSERT ON journal_rows
  WHEN json_extract(NEW.row_json, '$.recovered') = 1
  BEGIN SELECT RAISE(ABORT, 'temporary storage failure'); END;
`

/** The live child leaves a running turn, and a pending prompt when asked, in the journal. */
export async function leaveUnfinishedWork(
  current: QueuedMessageTestRig,
  options: { prompt?: true } = {}
): Promise<void> {
  const events = current.providerEvents()
  events.appendItem(
    TURN,
    { kind: 'turn', turnId: 'unfinished', state: 'running' },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  if (options.prompt) {
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
  await current.host.flushStreamedEvents(SESSION)
}

/** The child dies on its own while the database refuses every settlement row: the exit releases
 *  its lease (proof written, fence moved) and its work stays saved as running. */
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
