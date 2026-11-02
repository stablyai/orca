import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import {
  readAgentSessionHistory,
  readAgentSessionHydrationPage,
  type AgentSessionHistoryScope
} from '../agent-session-wire/agent-session-history-page'
import { projectJournalBatch } from '../agent-session-wire/agent-session-journal-batch'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  publishTestJournalEpoch
} from './journal-host-database-test-support'
import type { JournalHostDatabase } from './journal-host-database'
import { JournalOutcomeCompaction } from './journal-outcome-compaction'
import { JOURNAL_OUTCOME_FORMAT } from './journal-outcome-format'
import { publishJournalOutcomeEpoch } from './journal-outcome-write'
import { journalInputOrder } from './journal-input-order'
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
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { encodeJournalState } from './journal-state-codec'
import { restoreJournal } from './journal-open'
import { applyJournalRow, createJournalReducerState, renderJournalState } from './journal-reducer'
import type { AgentSessionJournal } from './journal-store'
import type { AgentJournalSnapshot } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentSessionHistoryRequest,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session/agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/agent-session/structured-agent-session-reducer'
import { projectStructuredItemsToNativeChat } from '../../../shared/agent-session/view/structured-agent-session-projection'
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

it.each([1, 'mixed', 'upgrade', 2] as const)(
  'keeps format %s prefix bytes, masks and re-creation order',
  async (format) => {
    const state = seedProjectionRows(database, [
      projectionEpochRow,
      item(2, 'x', 1),
      item(3, 'y', 1)
    ])
    const rig = projectionWriter(database, state)
    rigs.push(rig)
    const raw = () => database.db.prepare('SELECT * FROM journal_rows ORDER BY seq').all()
    const prefix = raw()
    for (let revision = 2; revision <= 40; revision++) {
      await rig.writer.enqueue((seq) => item(seq, 'x', revision))
      if (revision === 10) {
        await rig.writer.enqueue((seq) => item(seq, 'y', 2))
      }
      if (format === 'mixed' && revision === 20) {
        await rig.writer.enqueue((seq) => ({
          ...base(seq),
          kind: 'tombstone',
          itemId: 'x',
          revision: 21
        }))
        // Synthetic old-format records: ordinary values have the same frozen meaning in formats 1/2.
        database.db.prepare('UPDATE journal_outcomes SET format = 1').run()
      }
    }
    await rig.writer.enqueue((seq) => ({
      ...base(seq),
      kind: 'tombstone',
      itemId: 'y',
      revision: 3
    }))
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
    if (format === 1 || format === 'upgrade') {
      database.db.prepare('UPDATE journal_outcomes SET format = 1').run()
      database.db.prepare('UPDATE journal_outcome_epochs SET format = 1').run()
    }
    const compaction = new JournalOutcomeCompaction()
    if (format === 'upgrade') {
      // The pass has captured a format-1 boundary; a real write raises the epoch during its rest.
      expect(compaction.page(database)).toBe(true)
      await rig.writer.enqueue((seq) => item(seq, 'x', 43))
    }
    const before = records()
    const rows = raw()
    const facts = before.filter((row) => row.deleted === 1 || row.field === 'tombstones')
    expect(facts.some((row) => row.field === 'items' && row.entry_key === '"y"')).toBe(true)
    compact(compaction)
    expect(records().length).toBeLessThan(before.length)
    const xValues = before.filter(
      (row) => row.field === 'items' && row.entry_key === '"x"' && row.deleted === 0
    )
    expect(
      records().filter(
        (row) => row.field === 'items' && row.entry_key === '"x"' && row.deleted === 0
      )
    ).toEqual([xValues[0], xValues.at(-1)])
    expect(records().filter((row) => row.deleted === 1 || row.field === 'tombstones')).toEqual(
      facts
    )
    expect(raw()).toEqual(rows)
    expect(raw().slice(0, prefix.length)).toEqual(prefix)
    for (const row of records()) {
      expect(before).toContainEqual(row)
    }
    expect([...rig.state().items.keys()]).toEqual(['z', 'x'])
    expectProjectionMatches(database, rig.state())
  }
)

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

it.each(['format', 'collection', 'scalar', 'old-native', 'epoch'] as const)(
  'stops at an unknown record %s and never deletes anything after it',
  (unknown) => {
    seedOutcomeRows(database, [
      projectionEpochRow,
      ...Array.from({ length: 100 }, (_, n) => item(n + 2, 'x', n + 1))
    ])
    // A mismatched summary also exercises the per-record fence rather than only the fast summary.
    if (unknown === 'format') {
      database.db
        .prepare('UPDATE journal_outcomes SET format = ? WHERE seq = 40')
        .run(JOURNAL_OUTCOME_FORMAT + 1)
    } else if (unknown === 'epoch') {
      database.db
        .prepare('UPDATE journal_outcome_epochs SET format = ?')
        .run(JOURNAL_OUTCOME_FORMAT + 1)
    } else if (unknown === 'collection') {
      database.db
        .prepare(
          "UPDATE journal_outcomes SET field = 'futureCollection' WHERE seq = 40 AND field = 'items'"
        )
        .run()
    } else if (unknown === 'old-native') {
      database.db
        .prepare(
          "UPDATE journal_outcomes SET format = 1, field = 'inputEntries' WHERE seq = 40 AND field = 'items'"
        )
        .run()
    } else {
      database.db
        .prepare(
          `UPDATE journal_outcomes SET field = '$', entry_key = '"futureScalar"' WHERE seq = 40 AND field = 'items'`
        )
        .run()
    }
    database.transaction((db) => {
      publishTestJournalEpoch(db, 'healthy-successor', epoch)
      publishJournalOutcomeEpoch(db, 'healthy-successor', epoch, [
        projectionEpochRow,
        ...Array.from({ length: 100 }, (_, n) => item(n + 2, 'healthy', n + 1))
      ])
    })
    const affected = () => records().filter((row) => row.generation === 1)
    const before = affected()
    const atOrAfterUnknown = (row: (typeof before)[number]) =>
      Number(row.seq) > 40 ||
      (row.seq === 40 &&
        String(row.field) >=
          (unknown === 'collection'
            ? 'futureCollection'
            : unknown === 'old-native'
              ? 'inputEntries'
              : '$'))
    compact()
    if (unknown === 'epoch') {
      expect(affected()).toEqual(before)
    } else {
      expect(affected().length).toBeLessThan(before.length)
    }
    expect(affected().filter(atOrAfterUnknown)).toEqual(before.filter(atOrAfterUnknown))
    expect(
      records().filter((row) => row.field === 'items' && row.entry_key === '"healthy"')
    ).toHaveLength(2)
  }
)

it('delivers cleaned storage through bounded history, desktop/phone reducers, requests and worker text', async () => {
  const prefix = [projectionEpochRow, item(2, 'deleted-prefix', 1), item(3, 'prefix', 1)]
  const rig = projectionWriter(database, seedProjectionRows(database, prefix))
  rigs.push(rig)
  const historical = new Map<number, AgentJournalSnapshot>()
  const capture = (snapshot: AgentJournalSnapshot) => {
    historical.set(snapshot.cursor.sequence, structuredClone(snapshot))
  }
  const initial = createJournalReducerState(sessionId, epoch)
  capture(renderJournalState(initial))
  for (const row of prefix) {
    applyJournalRow(initial, row)
    capture(renderJournalState(initial))
  }
  const append = async (build: (seq: number) => JournalRow) => {
    await rig.writer.enqueue(build)
    capture(renderJournalState(rig.state()))
  }
  const expectHistoricalDispatch = () => {
    expect(historical.get(4)?.cursor).toEqual({ epoch, sequence: 4 })
    expect(historical.get(4)?.submissions).toMatchObject([
      { clientMessageId: 'sent', dispatchState: 'pending', providerItemId: null, resolvedAt: null }
    ])
    expect(historical.get(5)?.cursor).toEqual({ epoch, sequence: 5 })
    expect(historical.get(5)?.submissions).toMatchObject([
      {
        clientMessageId: 'sent',
        dispatchState: 'accepted',
        providerItemId: 'echo',
        resolvedAt: 1005
      }
    ])
  }
  await append((seq) => ({
    ...base(seq),
    kind: 'submission',
    clientMessageId: 'sent',
    payloadFingerprint: 'sent',
    handoverRecorded: true,
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
  expectHistoricalDispatch()
  await append((seq) => ({
    ...base(seq),
    kind: 'item',
    itemId: 'echo',
    revision: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
  }))
  await append((seq) => ({
    ...base(seq),
    kind: 'submission',
    clientMessageId: 'kept',
    payloadFingerprint: 'kept',
    handoverRecorded: true,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'keep queued' }] },
    providerHandle: { kind: 'codex', threadId: 'thread-1' }
  }))
  await append((seq) => ({
    ...base(seq),
    kind: 'queue',
    messageId: 'card',
    change: {
      op: 'queued',
      position: 0,
      queuedAt: { epoch, sequence: seq },
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'keep queued' }] }
    }
  }))
  await append((seq) => ({
    ...base(seq),
    kind: 'dispatch',
    clientMessageId: 'kept',
    state: 'rejected',
    providerItemId: null,
    reason: null,
    keptAsQueuedMessageId: 'card'
  }))
  await append((seq) => ({
    ...base(seq),
    kind: 'submission',
    clientMessageId: 'pending',
    payloadFingerprint: 'pending',
    handoverRecorded: true,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'pending' }] },
    providerHandle: { kind: 'codex', threadId: 'thread-1' }
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
    if (revision === 6) {
      // Synthetic old-format ordinary records; native joins exist only in format 2.
      database.db
        .prepare(
          "UPDATE journal_outcomes SET format = 1 WHERE field NOT IN ('inputEntries', 'inputCards')"
        )
        .run()
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
  // Synthetic ordinal control: native b claims no ordinary prefix membership.
  database.db
    .prepare(
      "UPDATE journal_outcomes SET ordinal = 'b' WHERE field = 'inputEntries' AND entry_key = ?"
    )
    .run('"pending"')
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
    const forward: {
      cursor: AgentJournalSnapshot['cursor']
      messages: ReturnType<typeof projectStructuredItemsToNativeChat>
      submissions: AgentJournalSnapshot['submissions']
    }[] = []
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
  const native = (state: ReturnType<typeof rig.state>) => ({
    entries: [...state.inputEntries],
    cards: [...state.inputCards],
    cut: journalInputOrder(state).place('pending')?.context.cut,
    introduced: journalInputOrder(state).lineage.cards.get('card')?.introduced
  })
  const expectedNative = structuredClone(native(rig.state()))
  expect(expectedNative.entries.map(([id]) => id)).toEqual(['pending'])
  expect(expectedNative.cards.map(([id]) => id)).toContain('card')
  expect(expectedNative.cut).toBeTypeOf('number')
  expect(expectedNative.introduced).toBeTypeOf('number')
  const expected = await consumers()
  const raw = database.db.prepare('SELECT * FROM journal_rows ORDER BY seq').all()
  const before = records()
  expect(before).toContainEqual(
    expect.objectContaining({
      field: 'inputEntries',
      entry_key: '"pending"',
      ordinal: 'b',
      deleted: 0
    })
  )
  expect(before).toContainEqual(
    expect.objectContaining({
      field: 'inputEntries',
      entry_key: '"sent"',
      value_json: 'null',
      deleted: 1
    })
  )
  compact()
  expect(records().length).toBeLessThan(before.length / 2)
  expect(native(restoreJournal(database.db, sessionId)!.state)).toEqual(expectedNative)
  expect(
    records().filter((row) => row.field === 'inputEntries' || row.field === 'inputCards')
  ).toEqual(before.filter((row) => row.field === 'inputEntries' || row.field === 'inputCards'))
  expect(database.db.prepare('SELECT * FROM journal_rows ORDER BY seq').all()).toEqual(raw)
  for (const row of records()) {
    expect(before).toContainEqual(row)
  }
  expect(await consumers()).toEqual(expected)
  await journals.closeAll()
  database = openTestJournalHostDatabase(root)
  journal = await journals.open({ identity, stateDirectory: root })
  expect(journal.snapshot()).toEqual(snapshot)
  expect(native(restoreJournal(database.db, sessionId)!.state)).toEqual(expectedNative)
  expect(await consumers()).toEqual(expected)
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'after-cleanup' },
    { kind: 'status', text: 'continued after mixed-format cleanup' },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  expect(renderJournalState(restoreJournal(database.db, sessionId)!.state)).toEqual(
    journal.snapshot()
  )
})
