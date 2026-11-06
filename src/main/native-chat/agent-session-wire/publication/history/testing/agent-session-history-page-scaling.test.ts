import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  boundHistoryItemsByBytes,
  newestWholeSequenceGroups
} from '../agent-session-history-page-bounds'

function item(index: number): AgentJournalRenderItem {
  return {
    itemId: String(index),
    revision: 1,
    sequence: index,
    observedAt: index,
    body: { kind: 'status', text: 'ok' }
  }
}

it('retains entire boundary groups and preserves oversized first-group truncation', () => {
  const items = [item(1), { ...item(2), sequence: 1 }, item(3), { ...item(4), sequence: 3 }]
  expect(newestWholeSequenceGroups(items, 1)).toEqual(items.slice(2))
  expect(newestWholeSequenceGroups(items, 3)).toEqual(items.slice(2))
  expect(boundHistoryItemsByBytes(items, 'oldest', new Map(), 1)).toMatchObject({
    dropped: 2,
    items: [{ itemId: '1' }, { itemId: '2' }]
  })
  expect(boundHistoryItemsByBytes(items, 'newest', new Map(), 1)).toMatchObject({
    dropped: 2,
    items: [{ itemId: '3' }, { itemId: '4' }]
  })
})
