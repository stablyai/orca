import { expect, it } from 'vitest'
import { SessionNewestFiles } from './session-newest-files'
import type { FileWithMtime } from './session-scanner-types'

function file(i: number): FileWithMtime {
  const mtimeMs = (i * 7919) % 997
  return { path: String(i), mtimeMs, modifiedAt: new Date(mtimeMs).toISOString() }
}

it('retains at most 12 of 100,000 candidates with stable newest-first ties', () => {
  const all = Array.from({ length: 100_000 }, (_, i) => file(i))
  const retained = new SessionNewestFiles(12)
  let peak = 0
  for (const candidate of all) {
    retained.add(candidate)
    peak = Math.max(peak, retained.size)
  }
  expect(peak).toBe(12)
  expect(retained.newest()).toEqual(all.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 12))
})

it('supports full backfill and empty requests', () => {
  const all = new SessionNewestFiles(Infinity)
  const none = new SessionNewestFiles(0)
  for (let i = 0; i < 100; i++) {
    all.add(file(i))
    none.add(file(i))
  }
  expect(all.newest()).toHaveLength(100)
  expect(none.newest()).toEqual([])
})
