import { expect, it } from 'vitest'
import { PRWatchJobRunner } from './pr-refresh-watch-jobs'
import { PRRefreshRetryState } from './pr-refresh-retry-state'
import { PRRefreshPacing } from './pr-refresh-pacing'
import { PRRefreshQueue, type PRRefreshQueueEntry } from './pr-refresh-queue'
import { makeCandidate } from './pr-refresh-coordinator-test-harness'

it('yields a selected list read to another ready review before restoring its priority', () => {
  const pacing = new PRRefreshPacing()
  const queue = new PRRefreshQueue(() => {})
  const entry = (key: string, selected: boolean, priority: number): PRRefreshQueueEntry => ({
    key,
    candidate: makeCandidate({ cacheKey: key, isSelected: selected }),
    aliases: new Map(),
    reason: 'visible',
    priority,
    dueAt: 0,
    queuedAt: 0
  })
  const selected = entry('selected', true, 80)
  const other = entry('other', false, 40)
  queue.set(selected.key, selected)
  queue.set(other.key, other)
  const next = () => queue.ordered((a, b) => pacing.order(a, b))[0].key
  expect(next()).toBe('selected')
  pacing.noteBackgroundStart(selected)
  expect(next()).toBe('other')
  pacing.noteBackgroundStart(other)
  expect(next()).toBe('selected')
  pacing.noteBackgroundStart(selected)
  queue.delete(other.key)
  expect(next()).toBe('selected')
})

it('preserves a visible list turn when selected reads share the budget with aged watches', () => {
  const pacing = new PRRefreshPacing()
  const queue = new PRRefreshQueue(() => {})
  const watches = new PRWatchJobRunner(queue, new PRRefreshRetryState(), { schedule() {} })
  const entry = (key: string, selected: boolean): PRRefreshQueueEntry => ({
    key,
    candidate: makeCandidate({ isSelected: selected }),
    aliases: new Map(),
    reason: 'visible',
    priority: selected ? 80 : 40,
    dueAt: 0,
    queuedAt: 0
  })
  const selected = entry('selected', true)
  const other = entry('other', false)
  const watch: PRRefreshQueueEntry = {
    ...entry('watch', false),
    reason: 'watch',
    watch: { prKey: 'pr' }
  }
  for (const item of [selected, other, watch]) {
    queue.set(item.key, item)
  }
  const next = () => {
    watches.age(queue.values(), 120_000)
    return queue.ordered((a, b) => pacing.order(a, b))[0].key
  }
  const started = (item: PRRefreshQueueEntry) => {
    pacing.noteBackgroundStart(item)
    watches.noteBudgetedStart(item)
  }
  expect(next()).toBe('selected')
  started(selected)
  expect(next()).toBe('watch')
  started(watch)
  expect(next()).toBe('selected')
  started(selected)
  expect(next()).toBe('other')
})
