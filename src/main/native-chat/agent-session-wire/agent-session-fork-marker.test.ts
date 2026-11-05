import { expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AgentJournalRenderItemSchema } from '../../../shared/agent-session/journal/agent-session-journal-schemas'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session/agent-session-wire'
import { FORK_MARKER_ITEM_ID, withForkMarker, type ForkMarker } from './agent-session-fork-marker'
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
  const subscribers = new AgentSessionSubscribers({ readForkMarker: () => current })
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
  subscribers.refreshForkSources(() => fixture.journal, ['source-session'])
  expect(events).toMatchObject([
    {
      type: 'batch',
      batch: {
        cursor: fixture.journal.cursor(),
        items: [{}, { body: { text: 'Forked from Renamed chat' } }]
      }
    }
  ])
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
  const reader = withForkMarker(undefined, () => ({
    sourceName: 'Original chat',
    forkedFrom: { ...parent, childBoundary }
  }))
  await fixture.journal.replaceEpochItems('handle_forked', 1, [])
  const page = readAgentSessionHydrationPage(fixture.journal, 1, reader)
  expect(page.items).toMatchObject([
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
