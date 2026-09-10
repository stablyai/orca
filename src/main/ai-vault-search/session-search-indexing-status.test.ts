import { expect, it } from 'vitest'
import { SessionSearchIndexingStatus } from './session-search-indexing-status'

/** Every phase below `idle` describes work, and work begins at `start()`. */
function startedStatus(): SessionSearchIndexingStatus {
  const status = new SessionSearchIndexingStatus()
  status.setStarted()
  return status
}

it('reports idle until it is started, rather than describing work nobody asked for', () => {
  const status = new SessionSearchIndexingStatus()
  expect(status.snapshot().phase).toBe('idle')
  // Not `current` either: an index nobody built is not up to date.
  status.setFilesIndexed(0)
  expect(status.snapshot()).toMatchObject({ phase: 'idle', filesIndexed: 0 })

  status.setStarted()
  expect(status.snapshot().phase).toBe('indexing')
})

// `clear()` throws the index away, so the sweep that covered it no longer
// covers anything; without this the emptied index reports itself current.
it('stops calling itself swept once the index it swept has been cleared', () => {
  const status = startedStatus()
  status.sweepFinished(true)
  expect(status.snapshot().phase).toBe('current')

  status.forgetSweep()
  expect(status.snapshot().phase).toBe('indexing')
})

it('walks discovering to indexing to current, and reports degraded roots once settled', () => {
  const status = startedStatus()
  status.beginSweep()
  expect(status.snapshot()).toMatchObject({ phase: 'discovering', filesTotal: null })

  status.planned(2, 0)
  status.indexed(1_000)
  status.setFilesIndexed(1)
  expect(status.snapshot()).toMatchObject({ phase: 'indexing', filesIndexed: 1, filesTotal: 2 })

  status.setDegradedRoots([{ root: '/blocked', reason: 'EACCES' }])
  // Work in flight is the more useful thing to show; the roots are in the
  // snapshot either way.
  expect(status.snapshot().phase).toBe('indexing')
  status.sweepFinished(true)
  status.finishWork(123)
  expect(status.snapshot()).toMatchObject({ phase: 'degraded', lastReconcileAt: 123 })

  status.setDegradedRoots([])
  expect(status.snapshot().phase).toBe('current')
})

it('refuses to call itself current with work queued, or before a sweep finished', () => {
  const status = startedStatus()
  status.finishWork(1)
  // No sweep has ever completed, so nothing is known about the long tail.
  expect(status.snapshot().phase).toBe('indexing')

  status.sweepFinished(true)
  expect(status.snapshot().phase).toBe('current')

  status.setPending(3, 0)
  expect(status.snapshot().phase).toBe('indexing')
  status.setPending(0, 0)
  expect(status.snapshot().phase).toBe('current')
})

it('does not let an aborted sweep count as a finished one', () => {
  const status = startedStatus()
  status.sweepFinished(false)
  status.finishWork(1)
  // The outcome is the argument, so reporting an aborted sweep cannot latch it.
  expect(status.snapshot().phase).toBe('indexing')

  status.sweepFinished(true)
  expect(status.snapshot().phase).toBe('current')
  status.sweepFinished(false)
  // A later abort does not un-know that a whole sweep once finished.
  expect(status.snapshot().phase).toBe('current')
})

it('reports closed over every other phase', () => {
  const status = startedStatus()
  status.sweepFinished(true)
  status.finishWork(1)
  expect(status.snapshot().phase).toBe('current')
  status.setClosed()
  expect(status.snapshot().phase).toBe('closed')
})

it('reports paused over everything, and keeps the counters it had', () => {
  const status = startedStatus()
  status.beginSweep()
  status.planned(3, 1)
  status.indexed(10)
  status.setFilesIndexed(1)
  status.setPending(4, 2)
  status.setPaused(true)
  expect(status.snapshot()).toMatchObject({
    phase: 'paused',
    filesIndexed: 1,
    filesTotal: 3,
    failures: 1,
    filesPending: 4,
    droppedPending: 2
  })
})

it('starts a new sweep from zero', () => {
  const status = startedStatus()
  status.beginSweep()
  status.planned(1, 0)
  status.indexed(500)
  status.failed()
  status.beginSweep()
  expect(status.snapshot()).toMatchObject({
    bytesIndexed: 0,
    failures: 0
  })
})
