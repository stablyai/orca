import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import { expect, it, vi } from 'vitest'
import { sessionCrewChanges } from '../../runtime/orchestration/crew/crew-changes'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AgentJournalRenderItemSchema } from '../../../shared/agent-session/journal/agent-session-journal-schemas'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session/agent-session-wire'
import {
  FORK_MARKER_ITEM_ID,
  readForkMarker,
  withForkMarker,
  type ForkMarker
} from './agent-session-fork-marker'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import {
  readAgentSessionHistory,
  readAgentSessionHydrationPage
} from './agent-session-history-page'
import { remapForkChildBoundary } from './agent-session-fork-boundary-remap'
import { fixture, appendItems, item, body } from './agent-session-history-contract-test-fixture'

function marker(): ForkMarker {
  return {
    forkedFrom: {
      sessionId: 'source-session',
      itemId: 'source-reply',
      childBoundary: { kind: 'item', itemId: agentJournalItemKey(item(2)) }
    },
    sourceName: 'Original chat'
  }
}

it('keeps one wire-admissible marker with its anchor across page edges and forward revisions', async () => {
  await appendItems(3)
  const reader = withForkMarker(undefined, marker)
  const tail = readAgentSessionHistory(
    fixture.journal,
    { sessionId: 'session-1', direction: 'tail', limit: 1 },
    { reader }
  )
  const older = readAgentSessionHistory(
    fixture.journal,
    { sessionId: 'session-1', direction: 'before', cursor: tail.page.window.nextCursor, limit: 1 },
    { reader }
  )
  expect(older.page.items.map((row) => row.itemId)).toEqual([
    agentJournalItemKey(item(2)),
    FORK_MARKER_ITEM_ID
  ])
  for (const row of older.page.items) {
    expect(AgentJournalRenderItemSchema.safeParse(row).success).toBe(true)
  }
  expect(older.page.items.map((row) => row.sequenceIndex)).toEqual([0, 1])
  const cursor = fixture.journal.cursor()
  await fixture.journal.appendItem(item(2), body('revised inherited reply'), {
    fence: 1,
    turnScope: { kind: 'thread' }
  })
  const forward = readAgentSessionHistory(
    fixture.journal,
    { sessionId: 'session-1', direction: 'after', cursor },
    { reader, rowReplay: true }
  )
  expect(forward.page.items.map((row) => row.itemId)).toEqual([
    agentJournalItemKey(item(2)),
    FORK_MARKER_ITEM_ID
  ])
  expect(
    fixture.journal.currentRead().items.some((row) => row.itemId === FORK_MARKER_ITEM_ID)
  ).toBe(false)
})

it('refreshes an idle open child and a same-cursor reconnect after the source is renamed or deleted', async () => {
  await appendItems(2)
  let current = marker()
  const events: AgentSessionSubscribeEvent[] = []
  const subscribers = new AgentSessionSubscribers({
    readForkMarker: () => current,
    readForkJournal: () => fixture.journal
  })
  const close = subscribers.open({
    id: 'open',
    sessionId: 'session-1',
    journal: fixture.journal,
    fence: 1,
    emit: (event) => events.push(event),
    boundedFrames: true
  })
  current = { ...current, sourceName: 'Renamed chat' }
  events.length = 0
  const prefixReads = vi.spyOn(fixture.journal, 'currentRead')
  sessionCrewChanges.notify(
    Object.assign(new Set<'names'>(['names']), { recordIds: ['source-session'] })
  )
  expect(events).toMatchObject([
    {
      type: 'batch',
      batch: {
        cursor: fixture.journal.cursor(),
        items: [{}, { body: { text: 'Forked from Renamed chat' } }]
      }
    }
  ])
  expect(prefixReads).not.toHaveBeenCalled()
  prefixReads.mockRestore()
  current = { ...current, sourceName: 'another chat' }
  events.length = 0
  const reconnect = subscribers.open({
    id: 'reconnect',
    sessionId: 'session-1',
    journal: fixture.journal,
    cursor: fixture.journal.cursor(),
    fence: 1,
    emit: (event) => events.push(event)
  })
  expect(
    events
      .flatMap((event) => (event.type === 'batch' ? event.batch.items : []))
      .find((row) => row.itemId === FORK_MARKER_ITEM_ID)?.body
  ).toMatchObject({ text: 'Forked from another chat' })
  close()
  reconnect()
})

it('clamps a removed inherited boundary to start while retaining the parent relationship', async () => {
  await appendItems(2)
  const old = fixture.journal.currentRead().items
  const parent = marker().forkedFrom
  const childBoundary = remapForkChildBoundary(parent.childBoundary, old, [])
  let current = marker()
  const reader = withForkMarker(undefined, () => current)
  readAgentSessionHydrationPage(fixture.journal, 1, reader)
  const cursor = fixture.journal.cursor()
  await fixture.journal.replaceEpochItems('handle_forked', 1, [])
  current = { sourceName: 'Original chat', forkedFrom: { ...parent, childBoundary } }
  const result = readAgentSessionHistory(
    fixture.journal,
    {
      sessionId: 'session-1',
      direction: 'after',
      cursor
    },
    { reader, rowReplay: true }
  )
  expect(result).toMatchObject({ ok: false, reset: 'epoch_changed' })
  expect(result.page.items).toMatchObject([
    {
      itemId: FORK_MARKER_ITEM_ID,
      sequence: 0,
      body: { forkedFrom: { sessionId: 'source-session' } }
    }
  ])
})

it('does not move a pre-clear inherited boundary when only later context is rewound', async () => {
  await appendItems(4)
  const old = fixture.journal.currentRead().items
  const boundary = marker().forkedFrom.childBoundary
  const kept = [{ identity: item(3), body: body('item-3'), ownerFence: 0 }]
  expect(remapForkChildBoundary(boundary, old, kept, old[1].sequence)).toEqual({
    kind: 'item',
    itemId: agentJournalItemKey(item(2))
  })
  expect(
    remapForkChildBoundary(boundary, old, [
      { identity: item(1), body: body('item-1'), ownerFence: 0 }
    ])
  ).toEqual({ kind: 'item', itemId: agentJournalItemKey(item(1)) })
})

it('uses the source chat display fallback until a live conversation name exists', () => {
  const source = agentSessionRecordFixture({ sessionId: 'source', provider: 'claude' })
  const child = agentSessionRecordFixture({
    sessionId: 'child',
    forkedFrom: { sessionId: 'source', itemId: 'reply', childBoundary: { kind: 'start' } }
  })
  const store = { getRecord: (id: string) => (id === 'source' ? source : child) }
  expect(readForkMarker(store, 'child')?.sourceName).toBe('Claude Chat')
  source.conversationName = 'Renamed source'
  expect(readForkMarker(store, 'child')?.sourceName).toBe('Renamed source')
})

it('restores the surviving anchor group and removes the marker when its anchor is removed', async () => {
  await fixture.journal.appendLifecycleBatch({
    settlementId: 'inherited-group',
    fence: 1,
    mutations: [1, 2].map((id) => ({
      kind: 'item' as const,
      identity: item(id),
      body: body(`item-${id}`),
      turnScope: { kind: 'thread' as const }
    }))
  })
  const read = () => ({
    ...marker(),
    forkedFrom: {
      ...marker().forkedFrom,
      childBoundary: { kind: 'item' as const, itemId: agentJournalItemKey(item(1)) }
    }
  })
  const reader = withForkMarker(undefined, read)
  const initial = readAgentSessionHydrationPage(fixture.journal, 1, reader)
  expect(initial.items.map((row) => [row.itemId, row.sequenceIndex])).toEqual([
    [agentJournalItemKey(item(1)), 0],
    [FORK_MARKER_ITEM_ID, 1],
    [agentJournalItemKey(item(2)), 2]
  ])
  const cursor = fixture.journal.cursor()
  await fixture.journal.appendTombstone(item(1), { fence: 1 })
  const request = { sessionId: 'session-1', direction: 'after' as const, cursor }
  const delta = readAgentSessionHistory(fixture.journal, request, { reader, rowReplay: true })
  expect(delta.page.items).toMatchObject([
    { itemId: agentJournalItemKey(item(2)), sequenceIndex: 1 }
  ])
  expect(delta.page.removedItemIds).toEqual([agentJournalItemKey(item(1)), FORK_MARKER_ITEM_ID])
  // Byte-bound delivery can retry the same read before emitting it.
  expect(readAgentSessionHistory(fixture.journal, request, { reader, rowReplay: true })).toEqual(
    delta
  )
  // A reconnect creates a new reader over the same committed journal view.
  expect(
    readAgentSessionHistory(fixture.journal, request, {
      reader: withForkMarker(undefined, () => read()),
      rowReplay: true
    })
  ).toEqual(delta)
  await fixture.journal.appendItem(item(3), body('later stream'), {
    fence: 1,
    turnScope: { kind: 'thread' }
  })
  const unrelated = readAgentSessionHistory(
    fixture.journal,
    {
      sessionId: 'session-1',
      direction: 'after',
      cursor: delta.page.window.nextCursor
    },
    { reader, rowReplay: true }
  )
  expect(unrelated.page.items.map((row) => row.itemId)).toEqual([agentJournalItemKey(item(3))])
  const delayed = readAgentSessionHistory(fixture.journal, request, {
    reader: withForkMarker(undefined, () => read()),
    rowReplay: true
  })
  expect(delayed.page.items).toMatchObject([
    { itemId: agentJournalItemKey(item(2)), sequenceIndex: 1 },
    { itemId: agentJournalItemKey(item(3)) }
  ])
  expect(delayed.page.removedItemIds).toEqual([agentJournalItemKey(item(1)), FORK_MARKER_ITEM_ID])
})

it('moves the marker on an idle same-epoch remap and restores the former group', async () => {
  await fixture.journal.appendLifecycleBatch({
    settlementId: 'old-boundary-group',
    fence: 1,
    mutations: [1, 2].map((id) => ({
      kind: 'item' as const,
      identity: item(id),
      body: body(`item-${id}`),
      turnScope: { kind: 'thread' as const }
    }))
  })
  await fixture.journal.appendItem(item(3), body('child reply'), {
    fence: 1,
    turnScope: { kind: 'thread' }
  })
  let current: ForkMarker = {
    ...marker(),
    forkedFrom: {
      ...marker().forkedFrom,
      childBoundary: { kind: 'item', itemId: agentJournalItemKey(item(1)) }
    }
  }
  const events: AgentSessionSubscribeEvent[] = []
  const subscribers = new AgentSessionSubscribers({
    readForkMarker: () => current,
    readForkJournal: () => fixture.journal
  })
  const close = subscribers.open({
    id: 'remap',
    sessionId: 'session-1',
    journal: fixture.journal,
    fence: 1,
    emit: (event) => events.push(event)
  })
  try {
    events.length = 0
    current = {
      ...current,
      forkedFrom: {
        ...current.forkedFrom,
        childBoundary: { kind: 'item', itemId: agentJournalItemKey(item(3)) }
      }
    }
    sessionCrewChanges.notify(
      Object.assign(new Set<'records'>(['records']), { recordIds: ['source-session'] })
    )
    const rows = events.flatMap((event) => (event.type === 'batch' ? event.batch.items : []))
    expect(rows.map((row) => [row.itemId, row.sequenceIndex ?? 0])).toEqual([
      [agentJournalItemKey(item(1)), 0],
      [agentJournalItemKey(item(2)), 1],
      [agentJournalItemKey(item(3)), 0],
      [FORK_MARKER_ITEM_ID, 1]
    ])
    expect(events).toMatchObject([{ type: 'batch', batch: { cursor: fixture.journal.cursor() } }])
  } finally {
    close()
  }
})
