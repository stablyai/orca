import { expect, it } from 'vitest'
import { OrcadLiveCompletionDurability } from './orcad-live-completion-durability'

const completed = () => ({
  version: 2,
  phase: 'source-retired',
  manifest: { migrationId: 'migration' },
  retiredAt: '2026-09-07T00:00:00.000Z'
})

it('does not acknowledge capture until the primary writer succeeds', () => {
  const tracker = new OrcadLiveCompletionDurability()
  const candidate = completed()
  const snapshot = OrcadLiveCompletionDurability.capture([candidate])
  expect(tracker.matches(candidate)).toBe(false)
  tracker.acknowledge(snapshot)
  expect(tracker.matches(candidate)).toBe(true)
})

it('captures immutable bytes rather than a mutable reference to pending state', () => {
  const tracker = new OrcadLiveCompletionDurability()
  const candidate = completed()
  const original = structuredClone(candidate)
  const snapshot = OrcadLiveCompletionDurability.capture([candidate])
  candidate.retiredAt = '2030-01-01T00:00:00.000Z'
  tracker.acknowledge(snapshot)
  snapshot.clear()
  expect(tracker.matches(original)).toBe(true)
  expect(tracker.matches(candidate)).toBe(false)
})

it('replaces acknowledgment instead of accumulating obsolete completed journals', () => {
  const tracker = new OrcadLiveCompletionDurability()
  const candidate = completed()
  tracker.acknowledge(OrcadLiveCompletionDurability.capture([candidate]))
  tracker.acknowledge(OrcadLiveCompletionDurability.capture([]))
  expect(tracker.matches(candidate)).toBe(false)
})

it('invalidates ambiguous concurrent primary writes', () => {
  const tracker = new OrcadLiveCompletionDurability()
  const candidate = completed()
  tracker.acknowledge(OrcadLiveCompletionDurability.capture([candidate]))
  tracker.invalidate()
  expect(tracker.matches(candidate)).toBe(false)
})

it.each([
  undefined,
  {},
  [null],
  [{ ...completed(), version: 1 }],
  [{ ...completed(), phase: 'destination-committed' }],
  [completed(), completed()],
  [completed(), completed(), completed()],
  [completed(), { ...completed(), phase: 'destination-committed' }]
])('does not acknowledge malformed, legacy, pending or duplicate evidence: %j', (journals) => {
  const tracker = new OrcadLiveCompletionDurability()
  tracker.acknowledge(OrcadLiveCompletionDurability.capture(journals))
  expect(tracker.matches(completed())).toBe(false)
})
