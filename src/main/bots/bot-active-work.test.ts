import { describe, expect, it } from 'vitest'
import type { BotWorkerSummary } from '../../shared/bots/bot-work-list'
import { botActiveWorkSection } from './bot-active-work'

const item = (number: number, status: 'needs_you' | 'working', lastActivityAt: number) => ({
  number,
  title: `Item ${number}`,
  status,
  lastActivityAt,
  links: []
})
const worker = (
  dispatchId: string,
  state: BotWorkerSummary['state'],
  pr: { number: number; state: 'open' | 'merged'; checks: 'pending' | 'success' } | null = null
): BotWorkerSummary => ({
  id: dispatchId,
  title: `Fix "${dispatchId}" [now]`,
  agent: 'claude',
  state,
  dispatchId,
  workspace: null,
  server: null,
  pr: pr && { ...pr, url: 'https://example.test', review: null, headSha: null },
  startedAt: 1,
  source: { source: 'app', title: null }
})

describe("a bot's Active work block", () => {
  it('lists what waits on the owner first, then running workers, items in progress and open PRs', () => {
    const section = botActiveWorkSection(
      [item(7, 'working', 50), item(3, 'needs_you', 90), item(2, 'needs_you', 10)],
      [
        worker('ctx_done', 'completed', { number: 4417, state: 'open', checks: 'success' }),
        worker('ctx_merged', 'completed', { number: 4400, state: 'merged', checks: 'success' }),
        worker('ctx_run', 'working'),
        worker('ctx_gone', 'stopped')
      ]
    )
    expect(section.text.split('\n').slice(2, 7)).toEqual([
      '#2 needs you: "Item 2"',
      '#3 needs you: "Item 3"',
      'dispatch:ctx_run working: "Fix ctx_run now"',
      '#7 in progress: "Item 7"',
      'dispatch:ctx_done finished, PR still open: "Fix ctx_done now" · PR #4417 open'
    ])
  })

  it('keeps its key when only order or CI checks change, so a turn does not resend it', () => {
    const first = botActiveWorkSection(
      [item(2, 'needs_you', 10), item(3, 'needs_you', 90)],
      [worker('ctx_run', 'working', { number: 4417, state: 'open', checks: 'pending' })]
    )
    const later = botActiveWorkSection(
      [item(3, 'needs_you', 5), item(2, 'needs_you', 10)],
      [worker('ctx_run', 'working', { number: 4417, state: 'open', checks: 'success' })]
    )
    expect(later.key).toBe(first.key)
    const merged = botActiveWorkSection(
      [item(2, 'needs_you', 10), item(3, 'needs_you', 90)],
      [worker('ctx_run', 'working', { number: 4417, state: 'merged', checks: 'success' })]
    )
    expect(merged.key).not.toBe(first.key)
  })

  it('shows at most 12 rows and says how many more there are', () => {
    const items = Array.from({ length: 15 }, (_, index) => item(index + 1, 'working', index))
    const lines = botActiveWorkSection(items, []).text.split('\n')
    expect(lines.filter((line) => line.startsWith('#'))).toHaveLength(12)
    expect(lines.some((line) => line.startsWith('(3 more:'))).toBe(true)
  })

  it('says when nothing is live, so a chat that saw work hears it ended', () => {
    expect(botActiveWorkSection([], [worker('ctx_gone', 'stopped')]).key).toBe('[]')
  })
})
