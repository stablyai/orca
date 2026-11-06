import { expect, it } from 'vitest'

import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalSnapshot } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { withForkMarker, type ForkMarker } from '../agent-session-fork-marker'
import { projectJournalBatch } from '../agent-session-journal-batch'

import { fixture, appendItems, item } from './agent-session-history-contract-test-fixture'

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

it('does not expand the marker for a submission-only absence, but keeps real submission-shaped bubbles and removals', async () => {
  await appendItems(2)
  const snapshot = fixture.journal.currentRead()
  const reader = withForkMarker(undefined, marker)
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
  expect(submissionOnly).toMatchObject({
    ok: true,
    batch: { items: [], removedItemIds: ['orca:not-a-bubble'] }
  })
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
      items: [
        { itemId: 'orca:real-bubble', body: { role: 'user' } },
        { itemId: 'orca:forked-from' }
      ],
      removedItemIds: []
    }
  })
  expect(update({ ...withBubble, items: [withBubble.items[1]] })).toMatchObject({
    ok: true,
    batch: { items: [], removedItemIds: ['orca:real-bubble', 'orca:forked-from'] }
  })
})
