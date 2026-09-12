import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import {
  boundHistoryItemsByBytes,
  historyEntryBytes,
  newestWholeSequenceGroups,
  oversizedHistoryItem
} from './agent-session-history-page-bounds'

/** The pre-generator eager grouping, verbatim, as the differential oracle. */
function referenceGroups(items: readonly AgentJournalRenderItem[]): AgentJournalRenderItem[][] {
  const groups: AgentJournalRenderItem[][] = []
  for (const item of items) {
    const current = groups.at(-1)
    if (current?.[0]?.sequence === item.sequence) {
      current.push(item)
    } else {
      groups.push([item])
    }
  }
  return groups
}

function referenceNewestWholeSequenceGroups(
  items: readonly AgentJournalRenderItem[],
  limit: number
): AgentJournalRenderItem[] {
  const selected: AgentJournalRenderItem[][] = []
  let count = 0
  for (const group of referenceGroups(items).toReversed()) {
    if (selected.length > 0 && count + group.length > limit) {
      break
    }
    selected.push(group)
    count += group.length
  }
  return selected.toReversed().flat()
}

function referenceBoundHistoryItemsByBytes(
  items: AgentJournalRenderItem[],
  keep: 'newest' | 'oldest',
  submissionBytes: ReadonlyMap<string, number>,
  maxBytes: number
): { items: AgentJournalRenderItem[]; dropped: number } {
  const groups = referenceGroups(items)
  const ordered = keep === 'newest' ? groups.toReversed() : groups
  const kept: AgentJournalRenderItem[][] = []
  let total = 0
  for (const group of ordered) {
    const bytes = group.reduce((sum, item) => sum + historyEntryBytes(item, submissionBytes), 0)
    if (kept.length === 0 && bytes > maxBytes) {
      kept.push(group.map((item) => oversizedHistoryItem(item, bytes)))
      break
    }
    if (total + bytes > maxBytes) {
      break
    }
    kept.push(group)
    total += bytes
  }
  return {
    items: (keep === 'newest' ? kept.toReversed() : kept).flat(),
    dropped: items.length - kept.reduce((count, group) => count + group.length, 0)
  }
}

function item(index: number, sequence: number): AgentJournalRenderItem {
  return {
    itemId: `i${index}`,
    revision: 1,
    sequence,
    observedAt: index,
    body: { kind: 'status', text: `s${index}` }
  }
}

/** Every sequence-run shape of `length` items, as run-length compositions. */
function* runShapes(length: number): Generator<number[]> {
  if (length === 0) {
    yield []
    return
  }
  for (let first = 1; first <= length; first += 1) {
    for (const rest of runShapes(length - first)) {
      yield [first, ...rest]
    }
  }
}

/** Build items from run lengths; `repeatSequence` reuses an earlier sequence value
 *  in a later run so non-adjacent duplicates are exercised too. */
function buildItems(runs: number[], repeatSequence: boolean): AgentJournalRenderItem[] {
  const items: AgentJournalRenderItem[] = []
  let index = 0
  runs.forEach((runLength, runIndex) => {
    const sequence = repeatSequence && runIndex > 0 && runIndex % 2 === 0 ? 0 : runIndex
    for (let i = 0; i < runLength; i += 1) {
      items.push(item(index++, sequence))
    }
  })
  return items
}

it('matches eager grouping at every newest-window limit for every run shape', () => {
  let cases = 0
  for (let length = 0; length <= 7; length += 1) {
    for (const runs of runShapes(length)) {
      for (const repeatSequence of [false, true]) {
        const items = buildItems(runs, repeatSequence)
        // Every boundary, including 0, each exact group edge, and past the end.
        for (let limit = 0; limit <= length + 1; limit += 1) {
          expect(
            newestWholeSequenceGroups(items, limit),
            `runs ${runs.join(',')} repeat ${repeatSequence} limit ${limit}`
          ).toEqual(referenceNewestWholeSequenceGroups(items, limit))
          cases += 1
        }
      }
    }
  }
  expect(cases).toBeGreaterThan(1000)
})

it('matches eager byte bounding at every budget boundary in both directions', () => {
  const submissionBytes = new Map<string, number>()
  let truncatedCases = 0
  let partialCases = 0
  for (let length = 1; length <= 6; length += 1) {
    for (const runs of runShapes(length)) {
      for (const repeatSequence of [false, true]) {
        const items = buildItems(runs, repeatSequence)
        const perItem = historyEntryBytes(items[0]!, submissionBytes)
        // Sweep exact group-boundary budgets plus one byte either side of each.
        const budgets = new Set<number>([0, 1])
        for (let n = 0; n <= length + 1; n += 1) {
          budgets.add(n * perItem - 1)
          budgets.add(n * perItem)
          budgets.add(n * perItem + 1)
        }
        for (const keep of ['newest', 'oldest'] as const) {
          for (const maxBytes of budgets) {
            const actual = boundHistoryItemsByBytes([...items], keep, submissionBytes, maxBytes)
            const expected = referenceBoundHistoryItemsByBytes(
              [...items],
              keep,
              submissionBytes,
              maxBytes
            )
            expect(
              actual,
              `runs ${runs.join(',')} repeat ${repeatSequence} keep ${keep} bytes ${maxBytes}`
            ).toEqual(expected)
            if (
              actual.items.some(
                (entry) => entry.body.kind === 'status' && /truncated/.test(entry.body.text)
              )
            ) {
              truncatedCases += 1
            } else if (actual.dropped > 0) {
              partialCases += 1
            }
          }
        }
      }
    }
  }
  // The oversized-first-group and partial-window paths must both be exercised.
  expect(truncatedCases).toBeGreaterThan(50)
  expect(partialCases).toBeGreaterThan(50)
})
