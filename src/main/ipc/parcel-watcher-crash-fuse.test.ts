import { describe, expect, it } from 'vitest'
import { WatcherProcessCrashFuse } from './parcel-watcher-crash-fuse'

describe('WatcherProcessCrashFuse', () => {
  it('opens after three crashes at the watcher restart cadence', () => {
    const fuse = new WatcherProcessCrashFuse()

    fuse.recordCrash(0)
    fuse.recordCrash(40_000)
    fuse.recordCrash(80_000)

    expect(fuse.isOpen(80_000)).toBe(true)
  })

  it('stays open until explicitly reset', () => {
    const fuse = new WatcherProcessCrashFuse()

    fuse.recordCrash(0)
    fuse.recordCrash(40_000)
    fuse.recordCrash(80_000)

    expect(fuse.isOpen(10 * 60_000)).toBe(true)
    fuse.reset()
    expect(fuse.isOpen(10 * 60_000)).toBe(false)
  })

  it('expires crashes outside the two-minute window', () => {
    const fuse = new WatcherProcessCrashFuse()

    fuse.recordCrash(0)
    fuse.recordCrash(40_000)
    fuse.recordCrash(120_000)

    expect(fuse.isOpen(120_000)).toBe(false)
  })
})
