import { expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { ForkMarker } from '../agent-session-fork-marker'
import { remapForkChildBoundary } from '../../../rewind/agent-session-fork-boundary-remap'
import { fixture, appendItems, item, body } from './agent-session-history-contract.test-fixture'

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

it('does not move a pre-clear inherited boundary when only later context is rewound', async () => {
  await appendItems(4)
  const old = await Promise.all(
    [1, 2, 3, 4].map((ordinal) => fixture.journal.reads.item(agentJournalItemKey(item(ordinal))))
  )
  if (old.some((entry) => entry === null)) {
    throw new Error('expected the inherited items')
  }
  const inherited = old.filter((entry) => entry !== null)
  const boundary = marker().forkedFrom.childBoundary
  const kept = [{ identity: item(3), body: body('item-3'), ownerFence: 0 }]
  expect(remapForkChildBoundary(boundary, inherited, kept, inherited[1].sequence)).toEqual({
    kind: 'item',
    itemId: 'codex:thread-1:turn-1:2'
  })
  expect(
    remapForkChildBoundary(boundary, inherited, [
      { identity: item(1), body: body('item-1'), ownerFence: 0 }
    ])
  ).toEqual({ kind: 'item', itemId: 'codex:thread-1:turn-1:1' })
})
