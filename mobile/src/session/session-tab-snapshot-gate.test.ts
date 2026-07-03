import { describe, expect, it } from 'vitest'
import {
  acceptSessionSnapshot,
  applyClosedTabTombstones,
  type AppliedSnapshotMarker
} from './session-tab-snapshot-gate'

describe('acceptSessionSnapshot', () => {
  it('accepts a newer version from the same publisher and advances the floor', () => {
    const marker: AppliedSnapshotMarker = { epoch: 'renderer:a', version: 5 }
    expect(
      acceptSessionSnapshot({ publicationEpoch: 'renderer:a', snapshotVersion: 6 }, marker)
    ).toBe(true)
    expect(marker).toEqual({ epoch: 'renderer:a', version: 6 })
  })

  it('rejects a strictly older version from the same publisher without moving the floor', () => {
    const marker: AppliedSnapshotMarker = { epoch: 'renderer:a', version: 42 }
    expect(
      acceptSessionSnapshot({ publicationEpoch: 'renderer:a', snapshotVersion: 41 }, marker)
    ).toBe(false)
    expect(marker).toEqual({ epoch: 'renderer:a', version: 42 })
  })

  it('accepts an equal version (reprocess) so close tombstones can expire and clear', () => {
    const marker: AppliedSnapshotMarker = { epoch: 'renderer:a', version: 42 }
    // Polling returns the same cached version repeatedly; reprocessing is needed
    // so applyClosedTabTombstones can run its TTL/clear pass.
    expect(
      acceptSessionSnapshot({ publicationEpoch: 'renderer:a', snapshotVersion: 42 }, marker)
    ).toBe(true)
    expect(marker).toEqual({ epoch: 'renderer:a', version: 42 })
  })

  it('accepts any version from a new publisher (epoch change) and resets the floor', () => {
    const marker: AppliedSnapshotMarker = { epoch: 'renderer:a', version: 99 }
    // Lower version but different epoch (renderer reload / headless) → accepted.
    expect(
      acceptSessionSnapshot({ publicationEpoch: 'headless:b', snapshotVersion: 1 }, marker)
    ).toBe(true)
    expect(marker).toEqual({ epoch: 'headless:b', version: 1 })
  })

  it('treats a missing epoch as its own publisher key', () => {
    const marker: AppliedSnapshotMarker = { epoch: null, version: -1 }
    expect(acceptSessionSnapshot({ snapshotVersion: 5 }, marker)).toBe(true)
    // A strictly older snapshot from the same (null) publisher is rejected.
    expect(acceptSessionSnapshot({ snapshotVersion: 4 }, marker)).toBe(false)
    expect(marker).toEqual({ epoch: null, version: 5 })
  })
})

describe('applyClosedTabTombstones', () => {
  const tab = (id: string): { id: string } => ({ id })

  it('returns the tabs untouched when there are no tombstones', () => {
    const tabs = [tab('a'), tab('b')]
    expect(applyClosedTabTombstones(tabs, new Map(), 1000)).toBe(tabs)
  })

  it('suppresses a tombstoned tab while it is still present and not expired', () => {
    const tombstones = new Map([['a', 5000]])
    const result = applyClosedTabTombstones([tab('a'), tab('b')], tombstones, 1000)
    expect(result.map((t) => t.id)).toEqual(['b'])
    // Still present in the publisher snapshot → tombstone retained for next time.
    expect(tombstones.has('a')).toBe(true)
  })

  it('clears the tombstone once the publisher snapshot no longer includes the tab', () => {
    const tombstones = new Map([['a', 5000]])
    const result = applyClosedTabTombstones([tab('b')], tombstones, 1000)
    expect(result.map((t) => t.id)).toEqual(['b'])
    expect(tombstones.has('a')).toBe(false)
  })

  it('stops suppressing and clears an expired tombstone even if still present', () => {
    const tombstones = new Map([['a', 5000]])
    const result = applyClosedTabTombstones([tab('a'), tab('b')], tombstones, 5000)
    expect(result.map((t) => t.id)).toEqual(['a', 'b'])
    expect(tombstones.has('a')).toBe(false)
  })
})
