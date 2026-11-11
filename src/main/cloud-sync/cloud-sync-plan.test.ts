import { describe, expect, it } from 'vitest'
import { isLocalCopyEdited, planSync, type IndexEntry, type LocalStat } from './cloud-sync-plan'

const limits = { maxFiles: 100, maxBytes: 10_000, maxFileBytes: 1_000 }
const entry = (size: number, mtime: number): IndexEntry => ({
  rs: size,
  rm: mtime,
  ls: size,
  lm: 5
})

describe('planSync', () => {
  it('copies new and changed files, skips unchanged ones', () => {
    const plan = planSync({
      remote: new Map([
        ['a.txt', { size: 10, mtime: 1 }],
        ['b.txt', { size: 20, mtime: 2 }],
        ['c.txt', { size: 30, mtime: 9 }]
      ]),
      index: { 'b.txt': entry(20, 2), 'c.txt': entry(30, 3) },
      local: new Map<string, LocalStat>([
        ['b.txt', { size: 20, mtimeMs: 5 }],
        ['c.txt', { size: 30, mtimeMs: 5 }]
      ]),
      limits
    })
    expect(plan.download).toEqual(['a.txt', 'c.txt'])
    expect(plan.remove).toEqual([])
    expect(plan.totalFiles).toBe(3)
  })

  it('restores a copy someone deleted on this computer', () => {
    const plan = planSync({
      remote: new Map([['a.txt', { size: 10, mtime: 1 }]]),
      index: { 'a.txt': entry(10, 1) },
      local: new Map<string, LocalStat>([['a.txt', null]]),
      limits
    })
    expect(plan.download).toEqual(['a.txt'])
  })

  it('keeps a local edit until the cloud changes that file, and reports it', () => {
    const edited = planSync({
      remote: new Map([['a.txt', { size: 10, mtime: 1 }]]),
      index: { 'a.txt': entry(10, 1) },
      local: new Map<string, LocalStat>([['a.txt', { size: 12, mtimeMs: 99 }]]),
      limits
    })
    expect(edited.download).toEqual([])
    expect(edited.editedHere).toEqual(['a.txt'])
    const cloudChanged = planSync({
      remote: new Map([['a.txt', { size: 11, mtime: 2 }]]),
      index: { 'a.txt': entry(10, 1) },
      local: new Map<string, LocalStat>([['a.txt', { size: 12, mtimeMs: 99 }]]),
      limits
    })
    expect(cloudChanged.download).toEqual(['a.txt'])
  })

  it('removes copies the cloud no longer has, only within the pass scope', () => {
    const plan = planSync({
      remote: new Map(),
      index: { 'gone.txt': entry(1, 1), 'other.txt': entry(1, 1) },
      local: new Map(),
      limits,
      scope: new Set(['gone.txt'])
    })
    expect(plan.remove).toEqual(['gone.txt'])
  })

  it('skips files over the per-file limit and stops at the folder limits', () => {
    const plan = planSync({
      remote: new Map([
        ['huge.bin', { size: 5_000, mtime: 1 }],
        ['a', { size: 600, mtime: 1 }],
        ['b', { size: 600, mtime: 1 }],
        ['c', { size: 100, mtime: 1 }]
      ]),
      index: {},
      local: new Map(),
      limits: { maxFiles: 10, maxBytes: 1_000, maxFileBytes: 1_000 }
    })
    expect(plan.skippedLarge).toBe(1)
    // Smallest first: c (100) + a (600) fit; b would pass 1,000.
    expect(plan.download).toEqual(['c', 'a'])
    expect(plan.overLimit).toBe(1)
  })

  it('counts files already here before new ones, so a full folder never evicts', () => {
    const plan = planSync({
      remote: new Map([
        ['kept', { size: 900, mtime: 1 }],
        ['new', { size: 200, mtime: 1 }]
      ]),
      index: { kept: entry(900, 1) },
      local: new Map<string, LocalStat>([['kept', { size: 900, mtimeMs: 5 }]]),
      limits: { maxFiles: 10, maxBytes: 1_000, maxFileBytes: 1_000 }
    })
    expect(plan.download).toEqual([])
    expect(plan.overLimit).toBe(1)
  })
})

describe('isLocalCopyEdited', () => {
  it('compares size and whole-millisecond mtime', () => {
    expect(isLocalCopyEdited(entry(10, 1), { size: 10, mtimeMs: 5.4 })).toBe(false)
    expect(isLocalCopyEdited(entry(10, 1), { size: 10, mtimeMs: 6 })).toBe(true)
    expect(isLocalCopyEdited(entry(10, 1), null)).toBe(false)
  })
})
