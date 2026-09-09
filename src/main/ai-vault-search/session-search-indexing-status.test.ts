import { expect, it } from 'vitest'
import { SessionSearchIndexingStatus } from './session-search-indexing-status'

it('walks discovering to indexing to current, and reports degraded roots once settled', () => {
  const status = new SessionSearchIndexingStatus()
  status.beginSweep()
  expect(status.snapshot()).toMatchObject({ phase: 'discovering', filesTotal: null })

  status.planned(2, 0)
  status.indexed(1_000)
  expect(status.snapshot()).toMatchObject({ phase: 'indexing', filesIndexed: 1, filesTotal: 2 })

  status.setDegradedRoots([{ root: '/blocked', reason: 'EACCES' }])
  // Work in flight is the more useful thing to show; the roots are in the
  // snapshot either way.
  expect(status.snapshot().phase).toBe('indexing')
  status.finishWork(123)
  expect(status.snapshot()).toMatchObject({ phase: 'degraded', lastReconcileAt: 123 })

  status.setDegradedRoots([])
  expect(status.snapshot().phase).toBe('current')
})

it('reports paused over everything, and keeps the counters it had', () => {
  const status = new SessionSearchIndexingStatus()
  status.beginSweep()
  status.planned(3, 1)
  status.indexed(10)
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

it('starts a new sweep from zero but keeps what only an open can know', () => {
  const status = new SessionSearchIndexingStatus()
  status.setRecoveredRows(7)
  status.beginSweep()
  status.planned(1, 0)
  status.indexed(500)
  status.failed()
  status.beginSweep()
  expect(status.snapshot()).toMatchObject({
    filesIndexed: 0,
    bytesIndexed: 0,
    failures: 0,
    recoveredRows: 7
  })
})
