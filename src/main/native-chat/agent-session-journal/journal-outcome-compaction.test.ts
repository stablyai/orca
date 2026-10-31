import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  readAgentSessionHistory,
  readAgentSessionHydrationPage,
  type AgentSessionHistoryScope
} from '../agent-session-wire/agent-session-history-page'
import { projectJournalBatch } from '../agent-session-wire/agent-session-journal-batch'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import type { JournalHostDatabase } from './journal-host-database'
import { JournalOutcomeCompaction } from './journal-outcome-compaction'
import {
  expectProjectionMatches,
  projectionBase as base,
  projectionEpoch as epoch,
  projectionEpochRow,
  projectionSessionId as sessionId,
  projectionWriter,
  seedOutcomeRows,
  seedProjectionRows
} from './journal-projection-test-support'
import type { JournalRow } from './journal-row-schema'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { encodeJournalState } from './journal-state-codec'
import { restoreJournal } from './journal-open'
import { applyJournalRow, createJournalReducerState, renderJournalState } from './journal-reducer'
import type { AgentSessionJournal } from './journal-store'
import type { AgentJournalSnapshot } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionHistoryRequest,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import { projectStructuredItemsToNativeChat } from '../../../shared/structured-agent-session-projection'
import { StructuredAgentSessionCurrentWork } from '../agent-session-wire/structured-agent-session-current-work'
import { CLIENT_HISTORY_READER } from '../agent-session-wire/agent-session-item-wire-form'
import { readStructuredLineageJournalPage } from '../../runtime/orchestration/structured-worker-journal-page'
import { boundStructuredJournalTail } from '../../runtime/orchestration/structured-worker-journal-archive'
import { formatWorkerTranscriptMessage } from '../../../shared/worker-transcript-text'

const workerHost = vi.hoisted(() => {
  const state: { journal: AgentSessionJournal | null } = { journal: null }
  return state
})
vi.mock('../agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({
    history: async (request: AgentSessionHistoryRequest, scope?: AgentSessionHistoryScope) => {
      if (!workerHost.journal) {
        throw new Error('missing test journal')
      }
      return readAgentSessionHistory(workerHost.journal, request, { scope })
    }
  })
}))

const phoneFeedPath = '../../../../mobile/src/session/mobile-structured-transcript-subscription'
const phoneClientPath = '../../../../mobile/src/transport/rpc-client-test-stub'
const { subscribeTranscriptAfterHold } = await import(phoneFeedPath)
const { stubRpcClient } = await import(phoneClientPath)

let root: string
let database: JournalHostDatabase
const journals = createTrackedJournalOpener()
const rigs: ReturnType<typeof projectionWriter>[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-outcome-compaction-'))
  database = openTestJournalHostDatabase(root)
})
afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    rig.queue.markClosed()
    await rig.queue.drain()
  }
  await journals.closeAll()
  workerHost.journal = null
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

const item = (seq: number, itemId: string, revision: number): JournalRow => ({
  ...base(seq),
  kind: 'item',
  itemId,
  revision,
  body: { kind: 'status', text: `${itemId} ${revision}` }
})
const records = () =>
  database.db.prepare('SELECT * FROM journal_outcomes ORDER BY seq, field, entry_key').all()
function compact(compaction = new JournalOutcomeCompaction()): void {
  while (compaction.page(database)) {
    // Each call commits at most one bounded page.
  }
}

it('keeps a mixed prefix byte-identical, including masks and ordering across deletion and re-creation', async () => {
  const state = seedProjectionRows(database, [projectionEpochRow, item(2, 'x', 1), item(3, 'y', 1)])
  const rig = projectionWriter(database, state)
  rigs.push(rig)
  const raw = () => database.db.prepare('SELECT * FROM journal_rows ORDER BY seq').all()
  const prefix = raw()
  for (let revision = 2; revision <= 40; revision++) {
    await rig.writer.enqueue((seq) => item(seq, 'x', revision))
  }
  await rig.writer.enqueue((seq) => ({ ...base(seq), kind: 'tombstone', itemId: 'y', revision: 2 }))
  await rig.writer.enqueue((seq) => ({
    ...base(seq),
    kind: 'lifecycle-batch',
    settlementId: 'reinsert',
    mutations: [
      { kind: 'tombstone', itemId: 'x', revision: 41 },
      { kind: 'item', itemId: 'z', revision: 1, body: { kind: 'status', text: 'z' } },
      { kind: 'item', itemId: 'x', revision: 42, body: { kind: 'status', text: 'x re-created' } }
    ]
  }))
  const before = records()
  const rows = raw()
  const facts = before.filter((row) => row.deleted === 1 || row.field === 'tombstones')
  expect(facts.some((row) => row.field === 'items' && row.entry_key === '"y"')).toBe(true)
  compact()
  expect(records().length).toBeLessThan(before.length)
  expect(records().filter((row) => row.deleted === 1 || row.field === 'tombstones')).toEqual(facts)
  expect(raw()).toEqual(rows)
  expect(raw().slice(0, prefix.length)).toEqual(prefix)
  for (const row of records()) {
    expect(before).toContainEqual(row)
  }
  expect([...rig.state().items.keys()]).toEqual(['z', 'x'])
  expectProjectionMatches(database, rig.state())
})

it.each([4, 40])(
  'bounds large copies after %i lifecycle re-creations and same-epoch context rewinds',
  async (size) => {
    const rig = projectionWriter(
      database,
      seedProjectionRows(database, [projectionEpochRow, item(2, 'prefix', 1)])
    )
    rigs.push(rig)
    const text = 'large saved body '.repeat(16_384)
    for (let n = 0; n < size; n++) {
      await rig.writer.enqueue((seq) => ({
        ...base(seq),
        kind: 'lifecycle-batch',
        settlementId: `recreate-${n}`,
        mutations: [
          { kind: 'tombstone', itemId: 'large', revision: n * 2 + 1 },
          {
            kind: 'item',
            itemId: 'large',
            revision: n * 2 + 2,
            body: { kind: 'status', text: `${n} ${text}` }
          }
        ]
      }))
    }
    const identity = {
      sessionId,
      workspaceId: 'ws',
      hostId: 'host',
      agent: 'codex' as const,
      providerHandle: codexProviderHandle('thread-1')
    }
    let journal = await journals.open({ identity, stateDirectory: root })
    const receipt = { write: () => {}, committed: () => {} }
    await journal.context.clear({ operationId: 'clear', afterFence: 1, clearedAt: 20_000 }, receipt)
    const floor = journal.context.floor()!
    const kept = {
      identity: { provider: 'orca' as const, clientMessageId: 'rewound' },
      body: { kind: 'status' as const, text },
      ownerFence: 1
    }
    await journal.appendItem(kept.identity, kept.body, { fence: 1, turnScope: { kind: 'thread' } })
    for (let n = 0; n < size; n++) {
      await journal.context.rewind(floor, 1, [kept], () => receipt)
      expect(journal.context.floor()).toEqual(floor)
      expect(journal.cursor().epoch).toBe(epoch)
    }
    const saved = encodeJournalState(restoreJournal(database.db, sessionId)!.state)
    const snapshot = journal.snapshot()
    const raw = database.db.prepare('SELECT * FROM journal_rows ORDER BY seq').all()
    const before = records()
    const removals = before.filter(
      (row) => row.deleted !== 0 || row.field === 'tombstones' || row.field === 'removedTurnIds'
    )
    const catchUp = () =>
      Array.from({ length: journal.cursor().sequence + 1 }, (_, sequence) => {
        const since = journal.readSince({ epoch, sequence })
        if (!since.ok) {
          throw new Error('missing catch-up')
        }
        return projectJournalBatch({
          rows: since.rows,
          snapshot: journal.snapshot(),
          afterSequence: sequence
        })
      })
    const expectedCatchUp = catchUp()
    compact()
    for (const id of ['large', agentJournalItemKey(kept.identity)]) {
      expect(
        records().filter(
          (row) =>
            row.field === 'items' && row.entry_key === JSON.stringify(id) && row.deleted === 0
        )
      ).toHaveLength(2)
    }
    expect(
      records().filter(
        (row) => row.deleted !== 0 || row.field === 'tombstones' || row.field === 'removedTurnIds'
      )
    ).toEqual(removals)
    for (const row of records()) {
      expect(before).toContainEqual(row)
    }
    expect(database.db.prepare('SELECT * FROM journal_rows ORDER BY seq').all()).toEqual(raw)
    expect(encodeJournalState(restoreJournal(database.db, sessionId)!.state)).toEqual(saved)
    expect(catchUp()).toEqual(expectedCatchUp)
    await journals.closeAll()
    database = openTestJournalHostDatabase(root)
    journal = await journals.open({ identity, stateDirectory: root })
    expect(journal.snapshot()).toEqual(snapshot)
    expect(catchUp()).toEqual(expectedCatchUp)
    // Continued writes use the retained latest ordinal and removal facts after a real cold reopen.
    await journal.context.rewind(floor, 1, [kept], () => receipt)
    expect(renderJournalState(restoreJournal(database.db, sessionId)!.state)).toEqual(
      journal.snapshot()
    )
    expect(journal.snapshot().items.map((value) => value.itemId)).toEqual(
      snapshot.items.map((value) => value.itemId)
    )
  }
)

it.each(['format', 'collection', 'scalar'] as const)(
  'stops at an unknown record %s and never deletes anything after it',
  (unknown) => {
    seedOutcomeRows(database, [
      projectionEpochRow,
      ...Array.from({ length: 100 }, (_, n) => item(n + 2, 'x', n + 1))
    ])
    // A mismatched summary also exercises the per-record fence rather than only the fast summary.
    if (unknown === 'format') {
      database.db.prepare('UPDATE journal_outcomes SET format = 2 WHERE seq = 40').run()
    } else if (unknown === 'collection') {
      database.db
        .prepare(
          "UPDATE journal_outcomes SET field = 'futureCollection' WHERE seq = 40 AND field = 'items'"
        )
        .run()
    } else {
      database.db
        .prepare(
          `UPDATE journal_outcomes SET field = '$', entry_key = '"futureScalar"' WHERE seq = 40 AND field = 'items'`
        )
        .run()
    }
    const before = records()
    const atOrAfterUnknown = (row: (typeof before)[number]) =>
      Number(row.seq) > 40 ||
      (row.seq === 40 && String(row.field) >= (unknown === 'collection' ? 'futureCollection' : '$'))
    compact()
    expect(records().length).toBeLessThan(before.length)
    expect(records().filter(atOrAfterUnknown)).toEqual(before.filter(atOrAfterUnknown))
    database.db.prepare('UPDATE journal_outcome_epochs SET format = 2').run()
    const stopped = records()
    compact()
    expect(records()).toEqual(stopped)
  }
)

it('delivers cleaned storage through bounded history, desktop/phone reducers, requests and worker text', async () => {
  const prefix = [projectionEpochRow, item(2, 'deleted-prefix', 1), item(3, 'prefix', 1)]
  const rig = projectionWriter(database, seedProjectionRows(database, prefix))
  rigs.push(rig)
  const historical = new Map<number, AgentJournalSnapshot>()
  const initial = createJournalReducerState(sessionId, epoch)
  historical.set(0, renderJournalState(initial))
  for (const row of prefix) {
    applyJournalRow(initial, row)
    historical.set(row.seq, renderJournalState(initial))
  }
  const append = async (build: (seq: number) => JournalRow) => {
    await rig.writer.enqueue(build)
    historical.set(rig.state().lastSequence, renderJournalState(rig.state()))
  }
  await append((seq) => ({
    ...base(seq),
    kind: 'submission',
    clientMessageId: 'sent',
    payloadFingerprint: 'sent',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
    providerHandle: { kind: 'codex', threadId: 'thread-1' }
  }))
  await append((seq) => ({
    ...base(seq),
    kind: 'dispatch',
    clientMessageId: 'sent',
    state: 'accepted',
    providerItemId: 'echo',
    reason: null
  }))
  await append((seq) => ({
    ...base(seq),
    kind: 'item',
    itemId: 'echo',
    revision: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
  }))
  await append((seq) => ({
    ...base(seq),
    kind: 'item',
    itemId: 'turn',
    revision: 1,
    body: { kind: 'turn', turnId: 'removed-turn', state: 'completed' }
  }))
  await append((seq) => ({ ...base(seq), kind: 'tombstone', itemId: 'turn', revision: 2 }))
  await append((seq) => ({
    ...base(seq),
    kind: 'tombstone',
    itemId: 'deleted-prefix',
    revision: 2
  }))
  for (let revision = 1; revision <= 12; revision++) {
    for (const id of ['x', 'y', 'z']) {
      await append((seq) => ({
        ...base(seq),
        kind: 'item',
        itemId: id,
        revision,
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: `${id} ${revision} ${'content '.repeat(70)}` }]
        }
      }))
    }
  }
  await append((seq) => ({
    ...base(seq),
    kind: 'lifecycle-batch',
    settlementId: 'reorder',
    mutations: [
      { kind: 'tombstone', itemId: 'x', revision: 13 },
      {
        kind: 'item',
        itemId: 'added',
        revision: 1,
        body: { kind: 'status', text: 'added between re-creations' }
      },
      {
        kind: 'item',
        itemId: 'x',
        revision: 14,
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'x re-created' }]
        }
      }
    ]
  }))
  await append((seq) => ({
    ...base(seq),
    kind: 'item',
    itemId: 'approval',
    revision: 1,
    turnScope: { kind: 'thread' },
    body: {
      kind: 'approval',
      title: 'Allow action',
      detail: null,
      options: [],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
  }))
  await append((seq) => ({
    ...base(seq),
    kind: 'item',
    itemId: 'question',
    revision: 1,
    turnScope: { kind: 'thread' },
    body: {
      kind: 'question',
      question: 'Which file?',
      options: [],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
  }))
  const identity = {
    sessionId,
    workspaceId: 'ws',
    hostId: 'host',
    agent: 'codex' as const,
    providerHandle: codexProviderHandle('thread-1')
  }
  let journal = await journals.open({ identity, stateDirectory: root })
  const snapshot = journal.snapshot()
  expect(journal.canonicalItemId('echo')).toBe('orca:sent')
  expect(rig.state().removedTurnIds.has('removed-turn')).toBe(true)
  const reader = { ...CLIENT_HISTORY_READER, budgetBytes: 1_500 }
  const consumers = async () => {
    const work = new StructuredAgentSessionCurrentWork(journal, 1)
    expect(work.actionablePromptIds()).toEqual(['approval', 'question'])
    workerHost.journal = journal
    const worker = await readStructuredLineageJournalPage([sessionId])
    if (!worker) {
      throw new Error('missing worker history')
    }
    const workerText = boundStructuredJournalTail(worker.items).messages.map(
      formatWorkerTranscriptMessage
    )
    expect(workerText.join('\n')).toContain('x re-created')
    expect(workerText.join('\n')).toContain('hello')
    const tail = readAgentSessionHistory(
      journal,
      { sessionId, direction: 'tail', limit: 3 },
      { reader }
    )
    let backward = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'event',
      event: { type: 'snapshot', sessionId, fence: 1, page: tail.page }
    })
    let page = tail.page
    let backwardPages = 1
    while (page.hasOlder) {
      const requestedCursor = page.window.nextCursor
      page = readAgentSessionHistory(
        journal,
        { sessionId, direction: 'before', cursor: requestedCursor, limit: 3 },
        { reader }
      ).page
      backward = reduceStructuredAgentSession(backward, {
        type: 'older-page',
        requestedCursor,
        page
      })
      expect(++backwardPages).toBeLessThan(20)
    }
    expect(backwardPages).toBeGreaterThan(2)
    expect(backward.items).toEqual(snapshot.items)
    const forward = []
    let shrunk = false
    for (const [sequence, prior] of historical) {
      let desktop = EMPTY_STRUCTURED_AGENT_SESSION
      let phone = EMPTY_STRUCTURED_AGENT_SESSION
      let deliverPhone: (event: unknown) => void = () => {
        throw new Error('phone not subscribed')
      }
      const subscribe = subscribeTranscriptAfterHold(
        stubRpcClient({
          subscribe: (_method: string, _params: unknown, onEvent: (raw: unknown) => void) => {
            deliverPhone = onEvent
            return () => {}
          }
        }),
        Promise.resolve(),
        () => false
      )
      const subscription = await subscribe(
        { sessionId },
        (event: AgentSessionSubscribeEvent) => {
          phone = reduceStructuredAgentSession(phone, { type: 'event', event }, 10_000)
        },
        (error: unknown) => {
          throw error
        },
        () => {}
      )
      const emit = (event: AgentSessionSubscribeEvent) => {
        desktop = reduceStructuredAgentSession(desktop, { type: 'event', event }, 10_000)
        deliverPhone(structuredClone(event))
      }
      emit({
        type: 'snapshot',
        sessionId,
        fence: 1,
        page: readAgentSessionHydrationPage(journal, 1, CLIENT_HISTORY_READER, prior)
      })
      let cursor = { epoch, sequence }
      let pages = 0
      for (;;) {
        const result = readAgentSessionHistory(
          journal,
          { sessionId, direction: 'after', cursor, limit: 3 },
          { reader, rowReplay: true }
        )
        expect(result.ok).toBe(true)
        const next = result.page.window.nextCursor
        if (result.page.hasNewer) {
          expect(next.sequence).toBeGreaterThan(cursor.sequence)
          const available = journal.readSince(cursor, 3)
          if (
            available.ok &&
            available.rows.filter((row) => row.seq <= next.sequence).length <
              Math.min(3, available.rows.length)
          ) {
            shrunk = true
          }
        }
        emit({
          type: 'batch',
          sessionId,
          batch: {
            cursor: next,
            items: result.page.items,
            removedItemIds: result.page.removedItemIds,
            submissions: result.page.submissions
          }
        })
        cursor = next
        expect(++pages).toBeLessThan(100)
        if (!result.page.hasNewer) {
          break
        }
      }
      subscription.unsubscribe()
      expect(desktop.items).toEqual(snapshot.items)
      expect(desktop.submissions).toEqual(snapshot.submissions)
      expect(phone).toEqual(desktop)
      forward.push({
        cursor,
        messages: projectStructuredItemsToNativeChat(desktop.items),
        submissions: desktop.submissions
      })
    }
    expect(shrunk).toBe(true)
    return { forward, backward, workerText, prompts: work.actionablePrompts() }
  }
  const expected = await consumers()
  const raw = database.db.prepare('SELECT * FROM journal_rows ORDER BY seq').all()
  const before = records()
  compact()
  expect(records().length).toBeLessThan(before.length / 2)
  expect(database.db.prepare('SELECT * FROM journal_rows ORDER BY seq').all()).toEqual(raw)
  for (const row of records()) {
    expect(before).toContainEqual(row)
  }
  expect(await consumers()).toEqual(expected)
  await journals.closeAll()
  database = openTestJournalHostDatabase(root)
  journal = await journals.open({ identity, stateDirectory: root })
  expect(journal.snapshot()).toEqual(snapshot)
  expect(await consumers()).toEqual(expected)
})
