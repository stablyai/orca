import { describe, expect, it } from 'vitest'
import {
  acceptSessionSnapshot,
  applyClosedTabTombstones,
  type AppliedSnapshotMarker
} from './session-tab-snapshot-gate'

describe('acceptSessionSnapshot', () => {
  it('rejects a strictly older version from the same publisher without moving the floor', () => {
    const marker: AppliedSnapshotMarker = { epoch: 'renderer:a', version: 42 }
    expect(
      acceptSessionSnapshot({ publicationEpoch: 'renderer:a', snapshotVersion: 41 }, marker)
    ).toBe(false)
    expect(marker).toEqual({ epoch: 'renderer:a', version: 42 })
  })

  it('accepts any version from a new publisher (epoch change) and resets the floor', () => {
    const marker: AppliedSnapshotMarker = { epoch: 'renderer:a', version: 99 }
    expect(
      acceptSessionSnapshot({ publicationEpoch: 'headless:b', snapshotVersion: 1 }, marker)
    ).toBe(true)
    expect(marker).toEqual({ epoch: 'headless:b', version: 1 })
  })
})

describe('applyClosedTabTombstones', () => {
  const tab = (id: string): { id: string } => ({ id })

  it('suppresses a tombstoned tab while it is still present and not expired', () => {
    const tombstones = new Map([['a', 5000]])
    const result = applyClosedTabTombstones([tab('a'), tab('b')], tombstones, 1000)
    expect(result.map((t) => t.id)).toEqual(['b'])
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
    expect(
      applyClosedTabTombstones([tab('a'), tab('b')], tombstones, 4999).map((t) => t.id)
    ).toEqual(['b'])
    expect(tombstones.has('a')).toBe(true)
    const result = applyClosedTabTombstones([tab('a'), tab('b')], tombstones, 5000)
    expect(result.map((t) => t.id)).toEqual(['a', 'b'])
    expect(tombstones.has('a')).toBe(false)
  })
})
