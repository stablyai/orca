import { expect, it, vi } from 'vitest'
import { sessionCrewChanges } from '../../runtime/orchestration/crew/crew-changes'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session/agent-session-wire'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { withForkMarker, FORK_MARKER_ITEM_ID, type ForkMarker } from './agent-session-fork-marker'
import { projectJournalBatch } from './agent-session-journal-batch'
import { readAgentSessionHistory } from './agent-session-history-page'
import { fixture, appendItems, item, body } from './agent-session-history-contract-test-fixture'

function marker(): ForkMarker {
  return {
    sourceName: 'Source',
    forkedFrom: {
      sessionId: 'source',
      itemId: 'reply',
      childBoundary: { kind: 'item', itemId: agentJournalItemKey(item(1)) }
    }
  }
}

it.each([100, 1000])(
  'adds constant marker work for an unrelated stream delta with %s inherited rows',
  async (count) => {
    await appendItems(2)
    const cursor = fixture.journal.cursor()
    await fixture.journal.appendItem(item(2), body('stream revision'), {
      fence: 1,
      turnScope: { kind: 'thread' }
    })
    const original = fixture.journal.currentRead()
    function measuredSnapshot() {
      const reads = { sequence: 0, itemId: 0 }
      const inherited = Array.from({ length: count }, (_, index): AgentJournalRenderItem => ({
        ...original.items[0],
        get itemId() {
          reads.itemId++
          return agentJournalItemKey(item(index === 0 ? 1 : index + 2))
        },
        get sequence() {
          reads.sequence++
          return 1
        },
        sequenceIndex: index
      }))
      return { reads, snapshot: { ...original, items: [...inherited, original.items[1]] } }
    }
    const plain = measuredSnapshot()
    const request = { sessionId: 'session-1', direction: 'after' as const, cursor }
    const control = readAgentSessionHistory(fixture.journal, request, {
      snapshot: plain.snapshot,
      rowReplay: true
    })
    const fork = measuredSnapshot()
    const result = readAgentSessionHistory(fixture.journal, request, {
      snapshot: fork.snapshot,
      reader: withForkMarker(undefined, marker),
      rowReplay: true
    })
    expect(result.page.items.map((row) => row.itemId)).toEqual([agentJournalItemKey(item(2))])
    expect(result.page.items).toEqual(control.page.items)
    // The journal's existing item index still reads IDs once; the marker adds no prefix pass.
    expect(fork.reads.itemId - plain.reads.itemId).toBe(0)
    expect(fork.reads.sequence).toBe(1)
  }
)

it('does not expand the marker for a submission-only absence, but keeps real submission-shaped bubbles and removals', async () => {
  await appendItems(2)
  const snapshot = fixture.journal.currentRead()
  const reader = withForkMarker(undefined, marker)
  const absent = agentJournalSubmissionKey('not-a-bubble')
  const submissionOnly = projectJournalBatch({
    rows: [
      {
        kind: 'outcome',
        epoch: snapshot.cursor.epoch,
        seq: snapshot.cursor.sequence,
        itemIds: [],
        submissionIds: ['not-a-bubble']
      }
    ],
    snapshot,
    afterSequence: 0,
    readSnapshot: (ids) => reader.snapshot!(fixture.journal, snapshot, ids)
  })
  expect(submissionOnly).toMatchObject({ ok: true, batch: { items: [], removedItemIds: [absent] } })
  const bubble = agentJournalSubmissionKey('real-bubble')
  const read = () => ({
    ...marker(),
    forkedFrom: { ...marker().forkedFrom, childBoundary: { kind: 'item' as const, itemId: bubble } }
  })
  const bubbleReader = withForkMarker(undefined, read)
  const withBubble: AgentJournalSnapshot = {
    ...snapshot,
    items: [
      {
        ...snapshot.items[0],
        itemId: bubble,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Actual input' }] }
      },
      snapshot.items[1]
    ]
  }
  const update = (current: AgentJournalSnapshot) =>
    projectJournalBatch({
      rows: [
        {
          kind: 'outcome' as const,
          epoch: current.cursor.epoch,
          seq: current.cursor.sequence,
          itemIds: [bubble],
          submissionIds: ['real-bubble']
        }
      ],
      snapshot: current,
      afterSequence: 0,
      readSnapshot: (ids) => bubbleReader.snapshot!(fixture.journal, current, ids)
    })
  expect(update(withBubble)).toMatchObject({
    ok: true,
    batch: {
      items: [{ itemId: bubble, body: { role: 'user' } }, { itemId: FORK_MARKER_ITEM_ID }],
      removedItemIds: []
    }
  })
  expect(update({ ...withBubble, items: [withBubble.items[1]] })).toMatchObject({
    ok: true,
    batch: { items: [], removedItemIds: [bubble, FORK_MARKER_ITEM_ID] }
  })
})

it('refreshes an idle source name from the boundary group without revisiting the inherited prefix', async () => {
  await appendItems(2)
  const view = fixture.journal.publicRead()
  const original = view.currentSnapshot()
  const reads = { sequence: 0, itemId: 0 }
  const snapshot = {
    ...original,
    items: Array.from({ length: 1000 }, (_, index): AgentJournalRenderItem => ({
      ...original.items[0],
      get itemId() {
        reads.itemId++
        return agentJournalItemKey(item(index + 1))
      },
      get sequence() {
        reads.sequence++
        return index + 1
      }
    }))
  }
  const publicRead = vi.spyOn(fixture.journal, 'publicRead').mockReturnValue({
    ...view,
    currentSnapshot: () => snapshot
  })
  const itemsRead = vi.spyOn(fixture.journal, 'itemsRead').mockReturnValue(snapshot)
  let current: ForkMarker = {
    ...marker(),
    forkedFrom: {
      ...marker().forkedFrom,
      childBoundary: { kind: 'item', itemId: agentJournalItemKey(item(1000)) }
    }
  }
  const events: AgentSessionSubscribeEvent[] = []
  const subscribers = new AgentSessionSubscribers({
    readForkMarker: () => current,
    readForkJournal: () => fixture.journal
  })
  const close = subscribers.open({
    id: 'idle-rename',
    sessionId: 'session-1',
    journal: fixture.journal,
    fence: 1,
    emit: (event) => events.push(event)
  })
  try {
    events.length = 0
    reads.sequence = 0
    reads.itemId = 0
    current = { ...current, sourceName: 'Renamed source' }
    sessionCrewChanges.notify(Object.assign(new Set<'names'>(['names']), { recordIds: ['source'] }))
    expect(events).toMatchObject([
      {
        type: 'batch',
        batch: {
          cursor: fixture.journal.cursor(),
          items: [
            { itemId: agentJournalItemKey(item(1000)) },
            { itemId: FORK_MARKER_ITEM_ID, body: { text: 'Forked from Renamed source' } }
          ]
        }
      }
    ])
    expect(reads.sequence).toBeLessThan(32)
    expect(reads.itemId).toBeLessThan(8)
  } finally {
    close()
    publicRead.mockRestore()
    itemsRead.mockRestore()
  }
})
