import { describe, expect, it } from 'vitest'
import { MAX_WSL_SNAPSHOT_RETAINED_ENTRIES, parseWslSnapshotFrame } from './wsl-watcher-snapshot'

describe('parseWslSnapshotFrame', () => {
  it('rejects a snapshot with more retained paths than the entry budget', () => {
    const records = Array.from(
      { length: MAX_WSL_SNAPSHOT_RETAINED_ENTRIES + 1 },
      (_, index) => `f\t1\t/repo/file-${index}\0`
    ).join('')

    expect(parseWslSnapshotFrame(records, 'Ubuntu')).toBeNull()
  })

  it('does not charge duplicate path updates as distinct retained entries', () => {
    const records = Array.from(
      { length: MAX_WSL_SNAPSHOT_RETAINED_ENTRIES + 1 },
      (_, index) => `f\t${index}\t/repo/same\0`
    ).join('')

    const snapshot = parseWslSnapshotFrame(records, 'Ubuntu')
    expect(snapshot).not.toBeNull()
    expect(snapshot?.size).toBe(1)
    expect(snapshot?.get('\\\\wsl.localhost\\Ubuntu\\repo\\same')?.mtime).toBe(
      String(MAX_WSL_SNAPSHOT_RETAINED_ENTRIES)
    )
  })
})
