import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import {
  boundHistoryItemsByBytes,
  newestWholeSequenceGroups
} from './agent-session-history-page-bounds'

function item(index: number): AgentJournalRenderItem {
  return {
    itemId: String(index),
    revision: 1,
    sequence: index,
    observedAt: index,
    body: { kind: 'status', text: 'ok' }
  }
}

it('visits only the retained sequence window and its boundary', () => {
  let reads = 0
  const items = Array.from({ length: 10000 }, (_, index) => ({
    ...item(index),
    get sequence() {
      reads += 1
      return index
    }
  }))
  expect(newestWholeSequenceGroups(items, 100).map((entry) => entry.itemId)).toEqual(
    Array.from({ length: 100 }, (_, index) => String(9900 + index))
  )
  expect(reads).toBeLessThan(300)
  reads = 0
  expect(boundHistoryItemsByBytes(items, 'newest', new Map(), 1000).items.length).toBeGreaterThan(0)
  expect(reads).toBeLessThan(100)
})

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
