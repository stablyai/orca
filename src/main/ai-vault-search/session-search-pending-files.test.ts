import { expect, it } from 'vitest'
import { SessionSearchPendingFiles } from './session-search-pending-files'

const entry = (path: string, forced = false) => ({ path, candidate: null, forced })

it('drops the oldest at the bound and counts what it dropped', () => {
  const pending = new SessionSearchPendingFiles(2)
  pending.add(entry('/a'))
  pending.add(entry('/b'))
  pending.add(entry('/c'))
  expect(pending.size).toBe(2)
  expect(pending.droppedCount).toBe(1)
  expect(pending.drain().map((one) => one.path)).toEqual(['/b', '/c'])
})

it('deduplicates a path and never downgrades a forced re-read', () => {
  const pending = new SessionSearchPendingFiles(10)
  pending.add(entry('/a', true))
  pending.add(entry('/a', false))
  expect(pending.size).toBe(1)
  expect(pending.drain()).toEqual([{ path: '/a', candidate: null, forced: true }])
})
