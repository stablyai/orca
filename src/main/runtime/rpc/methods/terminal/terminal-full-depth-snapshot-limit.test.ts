import { beforeEach, describe, expect, it } from 'vitest'
import {
  admitFullDepthSnapshot,
  admitRequestedSnapshotRows,
  resetFullDepthSnapshotLimitForTests
} from './terminal-full-depth-snapshot-limit'

const T0 = 1_800_000_000_000

// N-02: a hidden pane rebuilt on every reveal cannot pull a deep image each time.
describe('deep requested snapshots share the per-terminal ceiling', () => {
  beforeEach(() => {
    resetFullDepthSnapshotLimitForTests()
  })

  it('switching back and forth to a busy pane gets a few deep rebuilds a minute, then the 1000-row cut', () => {
    const rows = [0, 1, 2, 3, 4].map((i) => admitRequestedSnapshotRows('pty-1', 5000, T0 + i * 1000))
    expect(rows).toEqual([5000, 5000, 5000, 1000, 1000])
    expect(admitRequestedSnapshotRows('pty-1', 5000, T0 + 61_000)).toBe(5000)
  })

  it('leaves recovery-sized and unset requests alone', () => {
    for (let i = 0; i < 10; i++) {
      expect(admitRequestedSnapshotRows('pty-1', 1000, T0 + i)).toBe(1000)
    }
    expect(admitRequestedSnapshotRows('pty-1', undefined, T0)).toBeUndefined()
    expect(admitRequestedSnapshotRows('pty-1', 5000, T0)).toBe(5000)
  })

  it('counts against the same ceiling as full-depth subscribes', () => {
    expect(admitFullDepthSnapshot('pty-1', 'mount-a', T0)).toBe(true)
    expect(admitFullDepthSnapshot('pty-1', 'mount-b', T0 + 1)).toBe(true)
    expect(admitRequestedSnapshotRows('pty-1', 5000, T0 + 2)).toBe(5000)
    expect(admitFullDepthSnapshot('pty-1', 'mount-c', T0 + 3)).toBe(false)
    expect(admitRequestedSnapshotRows('pty-2', 5000, T0 + 4)).toBe(5000)
  })
})
