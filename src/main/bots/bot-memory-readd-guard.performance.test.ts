import { expect, it, vi } from 'vitest'
import type { BotMemoryHistoryRow } from '../../shared/bots/bot-memory-history'
import type * as LineWords from './bot-memory-line-words'

const similarity = vi.hoisted(() => ({ calls: 0 }))
vi.mock('./bot-memory-line-words', async (load) => {
  const actual = await load<typeof LineWords>()
  return {
    ...actual,
    wordSimilarity: (...args: Parameters<typeof actual.wordSimilarity>) => {
      similarity.calls += 1
      return actual.wordSimilarity(...args)
    }
  }
})

const { linesToKeepOut } = await import('./bot-memory-readd-guard')

const NOW = Date.UTC(2026, 10, 22)
const COPIES = 150

// Perf contract (STA-17040): history keeps every raw copy a tidy-up moved, so a fact listed 150
// times with different dates and sources was compared with each line a turn end added 150 times.
it('compares each added line once with a fact a tidy-up moved in many copies', () => {
  const removed = Array.from({ length: COPIES }, (_, index) => ({
    line: `- 2026-10-${String((index % 28) + 1).padStart(2, '0')} deploys run on friday · from: Slack ${index}`,
    after: null
  }))
  const row: BotMemoryHistoryRow = {
    id: 'r1',
    at: NOW,
    by: { kind: 'tidy-up' },
    change: { added: [], removed },
    undoable: true
  }
  const added = ['- 2026-11-22 deploys run on fridays', '- 2026-11-22 the cat is grey']

  expect(linesToKeepOut(added, [row], '', NOW)).toEqual(['- 2026-11-22 deploys run on fridays'])
  expect(similarity.calls).toBe(added.length)
})
