import { expect, it } from 'vitest'
import { SessionSearchCycleAllowance } from './session-search-reconcile-budget'

it('stops a cycle at the file bound and again at the byte bound', () => {
  const allowance = new SessionSearchCycleAllowance({ files: 3, bytes: 1_000 })
  expect([allowance.spend(10), allowance.spend(10), allowance.spend(10)]).toEqual([
    true,
    true,
    true
  ])
  expect(allowance.spend(10)).toBe(false)

  const bytes = new SessionSearchCycleAllowance({ files: 10, bytes: 100 })
  expect(bytes.spend(60)).toBe(true)
  expect(bytes.spend(60)).toBe(false)
  expect(bytes.remaining).toEqual({ files: 9, bytes: 40 })
})

it('lets one oversized transcript through rather than never reading it', () => {
  const allowance = new SessionSearchCycleAllowance({ files: 5, bytes: 100 })
  // Alone in the cycle it is admitted; behind other work it waits for the next.
  expect(allowance.spend(10_000)).toBe(true)
  expect(allowance.spend(1)).toBe(false)

  const crowded = new SessionSearchCycleAllowance({ files: 5, bytes: 100 })
  expect(crowded.spend(10)).toBe(true)
  expect(crowded.spend(10_000)).toBe(false)
})

it('does not let an idle stretch buy one unbounded cycle', () => {
  const allowance = new SessionSearchCycleAllowance({ files: 2, bytes: 100 })
  allowance.reset()
  allowance.reset()
  expect(allowance.remaining).toEqual({ files: 2, bytes: 100 })
})
