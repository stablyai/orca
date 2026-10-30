import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { SQLITE_TABLE_DISPOSITIONS } from '../../../shared/wsl-move/wsl-move-storage-dispositions'
import {
  applyJournalRow,
  createJournalReducerState,
  MAX_JOURNAL_APPLIED_SETTLEMENT_IDS,
  renderJournalState,
  type JournalReducerState
} from './journal-reducer'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  publishTestJournalEpoch,
  insertTestJournalRow,
  liveTestJournalRows,
  saveTestJournalState
} from './journal-host-database-test-support'
import { readJournalSavedState, readJournalSavedStatePages } from './journal-saved-state'
import type { JournalRow } from './journal-row-schema'
import type { JournalHostDatabase } from './journal-host-database'

const identity: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}
const providerHandle = { kind: 'codex', threadId: 'thread-1' } as const
const epoch = 'epoch-1'
const text = (
  value: string,
  role: 'user' | 'assistant' = 'assistant'
): AgentJournalMessageItem => ({
  kind: 'message',
  role,
  blocks: [{ type: 'text', text: value }]
})
const base = (seq: number) => ({ v: 4, epoch, seq, fence: 1, ts: 1_000 + seq })
const itemId = (ordinal: number) =>
  agentJournalItemKey({ provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal })
let root: string
let database: JournalHostDatabase
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-saved-state-'))
  database = openTestJournalHostDatabase(root)
})
afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function write(rows: readonly JournalRow[]): JournalReducerState {
  const state = createJournalReducerState(identity.sessionId, epoch)
  database.transaction((db) => {
    publishTestJournalEpoch(db, identity.sessionId, epoch)
    for (const row of rows) {
      insertTestJournalRow(db, identity.sessionId, row)
      applyJournalRow(state, row)
    }
  })
  return state
}

function requireState(state: JournalReducerState | null | undefined): JournalReducerState {
  expect(state).toBeTruthy()
  if (!state) {
    throw new Error('missing journal state')
  }
  return state
}

function expectSameState(actual: JournalReducerState, expected: JournalReducerState): void {
  expect(Object.keys(actual)).toEqual(Object.keys(expected))
  const actualFields: Record<string, unknown> = { ...actual }
  const expectedFields: Record<string, unknown> = { ...expected }
  for (const [field, right] of Object.entries(expectedFields)) {
    const left = actualFields[field]
    if (
      (left instanceof Map && right instanceof Map) ||
      (left instanceof Set && right instanceof Set)
    ) {
      expect([...left]).toStrictEqual([...right])
    } else if (field === 'queue') {
      expect([...actual.queue.cards]).toStrictEqual([...expected.queue.cards])
      expect(actual.queue.revision).toBe(expected.queue.revision)
    } else if (field === 'derivedTurnScope') {
      expect(actual.derivedTurnScope.snapshot()).toBe(expected.derivedTurnScope.snapshot())
    } else {
      expect(left).toStrictEqual(right)
    }
  }
  expect(renderJournalState(actual)).toStrictEqual(renderJournalState(expected))
}

it('round trips the complete replayed reducer, including insertion order and undefined echoes', () => {
  for (const table of [
    'journal_state',
    'journal_items',
    'journal_entries',
    'journal_rows',
    'journal_sessions'
  ]) {
    expect(
      database.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get(table)
    ).toEqual({ name: table })
    expect(SQLITE_TABLE_DISPOSITIONS[`agent-session-journal.${table}`]).toMatchObject({
      disposition: 'not-applicable',
      item: 52
    })
  }
  const user = text('Please investigate', 'user')
  const rows: JournalRow[] = [
    { ...base(1), kind: 'epoch', reason: 'legacy_import', providerHandle },
    {
      ...base(2),
      kind: 'queue',
      messageId: 'draft',
      change: {
        op: 'queued',
        body: user,
        position: 1,
        queuedAt: { epoch, sequence: 2 },
        options: { model: 'model-a' }
      }
    },
    {
      ...base(3),
      kind: 'submission',
      clientMessageId: 'send-1',
      payloadFingerprint: agentSessionSendBodyFingerprint(identity.sessionId, user),
      body: user,
      providerHandle,
      handoverRecorded: true,
      queuedMessageId: 'draft',
      origin: 'client'
    },
    {
      ...base(4),
      kind: 'dispatch',
      clientMessageId: 'send-1',
      state: 'pending',
      providerItemId: null,
      reason: null,
      carries: ['stopped-2', 'stopped-1']
    },
    { ...base(5), kind: 'item', itemId: itemId(1), revision: 1, body: user },
    {
      ...base(6),
      kind: 'item',
      itemId: itemId(2),
      revision: 1,
      body: text('echo'),
      echoOf: undefined
    },
    { ...base(7), kind: 'item', itemId: itemId(3), revision: 1, body: text('removed') },
    { ...base(8), kind: 'tombstone', itemId: itemId(3), revision: 2 },
    {
      ...base(9),
      kind: 'tombstone',
      itemId: 'stop',
      revision: 1,
      stopEvent: { reason: 'user-stop', at: 1_009 }
    },
    {
      ...base(10),
      kind: 'tombstone',
      itemId: 'clear',
      revision: 1,
      queueClear: { operationId: 'clear-1', messageIds: ['draft'] }
    },
    { ...base(11), kind: 'tombstone', itemId: 'reopen', revision: 1, queueReopen: true }
  ]
  for (let index = 0; index < MAX_JOURNAL_APPLIED_SETTLEMENT_IDS + 2; index++) {
    rows.push({
      ...base(rows.length + 1),
      kind: 'lifecycle-batch',
      settlementId: `settlement-${index}`,
      mutations: [
        { kind: 'item', itemId: itemId(4), revision: index + 1, body: text(`progress ${index}`) }
      ]
    })
  }
  rows.push({
    ...base(rows.length + 1),
    kind: 'item',
    itemId: itemId(7),
    revision: 1,
    body: { kind: 'turn', turnId: 'removed-turn', state: 'running' }
  })
  rows.push({ ...base(rows.length + 1), kind: 'tombstone', itemId: itemId(7), revision: 2 })
  rows.push({
    ...base(rows.length + 1),
    kind: 'item',
    itemId: itemId(5),
    revision: 1,
    body: { kind: 'turn', turnId: 'open-turn', state: 'running' }
  })
  rows.push({
    ...base(rows.length + 1),
    kind: 'item',
    itemId: itemId(6),
    revision: 1,
    executionOwner: 2,
    body: text('Working')
  })
  rows.push({
    ...base(rows.length + 1),
    kind: 'item',
    itemId: itemId(3),
    revision: 3,
    body: text('Recreated')
  })
  for (const clientMessageId of ['send-3', 'send-2']) {
    rows.push({
      ...base(rows.length + 1),
      kind: 'submission',
      clientMessageId,
      payloadFingerprint: agentSessionSendBodyFingerprint(identity.sessionId, user),
      body: user,
      providerHandle
    })
  }
  const state = write(rows)
  expect(state.items.has(agentJournalSubmissionKey('send-1'))).toBe(true)
  expect(state.itemEchoes.has(itemId(2))).toBe(true)
  expect(state.itemEchoes.get(itemId(2))).toBeUndefined()
  expect([...state.appliedSettlementIds][0]).toBe('settlement-2')
  expect(state.derivedTurnScope.snapshot()).toBe(itemId(5))
  saveTestJournalState(database, state)
  const restored = requireState(readJournalSavedState(database.db, identity.sessionId, epoch))
  expectSameState(restored, state)
  // A paced reader decodes the same state one stored row per page.
  const pages = readJournalSavedStatePages(() => database.db, identity.sessionId, epoch, {
    rows: 1,
    chars: Number.POSITIVE_INFINITY
  })
  let page = pages.next()
  let rests = 0
  for (; !page.done; page = pages.next()) {
    rests += 1
  }
  const paged = page.value
  expect(paged).not.toBeTypeOf('string')
  expectSameState(requireState(typeof paged === 'string' ? null : paged), state)
  expect(rests).toBeGreaterThan(state.items.size)
  expect(restored.derivedTurnScope.scopeFor(text('next'))).toEqual({
    kind: 'turn',
    turnItemId: itemId(5)
  })
  expect(liveTestJournalRows(database.db, identity.sessionId)).toHaveLength(rows.length)
  // An unreleased whole-state layout used version 1; its chats replay instead of decoding it.
  database.db
    .prepare('UPDATE journal_state SET version = 1 WHERE session_id = ?')
    .run(identity.sessionId)
  expect(readJournalSavedState(database.db, identity.sessionId, epoch)).toBeNull()
})
