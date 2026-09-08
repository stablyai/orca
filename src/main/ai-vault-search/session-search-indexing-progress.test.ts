import { afterEach, expect, it, vi } from 'vitest'
import { SessionSearchIndexingProgress } from './session-search-indexing-progress'

afterEach(() => vi.useRealTimers())

it('keeps discovery indeterminate and retains partial progress on pause', () => {
  const progress = new SessionSearchIndexingProgress()
  progress.discover()
  expect(progress.snapshot()).toMatchObject({ phase: 'discovering', filesTotal: null })
  progress.discovered(3, 0)
  progress.processed(false)
  progress.setPaused(true)
  progress.finish()
  expect(progress.snapshot()).toMatchObject({ phase: 'paused', filesTotal: 3, filesProcessed: 1 })
})

it('reports scan and parse failures without claiming the index is complete, and resets on retry', () => {
  const progress = new SessionSearchIndexingProgress()
  progress.discover()
  progress.discovered(2, 1)
  progress.processed(true)
  progress.processed(false)
  progress.finish()
  expect(progress.snapshot()).toMatchObject({ phase: 'error', failures: 2, filesProcessed: 2 })
  progress.discover()
  progress.discovered(2, 0)
  progress.processed(false)
  progress.processed(false)
  progress.finish()
  expect(progress.snapshot()).toMatchObject({ phase: 'complete', failures: 0 })
})

it('groups adjacent live writes into one burst and keeps failures visible', () => {
  vi.useFakeTimers()
  const progress = new SessionSearchIndexingProgress()
  const first = progress.beginWrite()
  const startedAt = progress.snapshot().startedAt
  vi.advanceTimersByTime(5000)
  first()
  const second = progress.beginWrite()
  expect(progress.snapshot()).toMatchObject({ phase: 'updating', filesTotal: 2, startedAt })
  progress.writeFailed()
  second()
  expect(progress.snapshot()).toMatchObject({ phase: 'error', failures: 1 })
})

it('lets a later successful write supersede a write error, but not a failed backfill', () => {
  const progress = new SessionSearchIndexingProgress()
  const failing = progress.beginWrite()
  progress.writeFailed()
  failing()
  expect(progress.snapshot().phase).toBe('error')
  progress.beginWrite()()
  expect(progress.snapshot().phase).toBe('complete')

  // A failed backfill stays red: configure() reads this phase to decide whether
  // to drop the memoized pass and enumerate again.
  progress.discover()
  progress.discovered(1, 0)
  progress.processed(true)
  progress.finish()
  expect(progress.snapshot().phase).toBe('error')
  progress.beginWrite()()
  expect(progress.snapshot().phase).toBe('error')
})

it('a write from an older pass does not advance a new backfill', () => {
  const progress = new SessionSearchIndexingProgress()
  const finish = progress.beginWrite()
  progress.discover()
  progress.discovered(4, 0)
  finish()
  expect(progress.snapshot()).toMatchObject({ phase: 'indexing', filesTotal: 4, filesProcessed: 0 })
})

it('rebuilds the batch when a write supersedes an error, so no failure count survives', () => {
  const progress = new SessionSearchIndexingProgress()
  const failing = progress.beginWrite()
  progress.writeFailed()
  failing()
  expect(progress.snapshot()).toMatchObject({ phase: 'error', failures: 1, filesTotal: 1 })
  progress.beginWrite()()
  expect(progress.snapshot()).toMatchObject({
    phase: 'complete',
    failures: 0,
    filesTotal: 1,
    filesProcessed: 1
  })
})

it('clears a superseded failure when a write that overlapped the error completes', () => {
  const progress = new SessionSearchIndexingProgress()
  const failing = progress.beginWrite()
  progress.writeFailed()
  const overlapping = progress.beginWrite()
  failing()
  overlapping()
  expect(progress.snapshot()).toMatchObject({ phase: 'complete', failures: 0 })
})
