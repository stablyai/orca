import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveWatcherProcessEntryPath } from './parcel-watcher-entry-path'

describe('resolveWatcherProcessEntryPath', () => {
  it('uses an adjacent entry when electron-vite appPath is already out/main', () => {
    const builtMainPath = path.join(process.cwd(), 'out', 'main')
    const adjacentEntry = path.join(builtMainPath, 'parcel-watcher-process-entry.js')

    expect(
      resolveWatcherProcessEntryPath(
        builtMainPath,
        false,
        (candidate) => candidate === adjacentEntry
      )
    ).toBe(adjacentEntry)
  })

  it('uses the nested build entry when appPath is the project root', () => {
    expect(resolveWatcherProcessEntryPath(process.cwd(), false, () => false)).toBe(
      path.join(process.cwd(), 'out', 'main', 'parcel-watcher-process-entry.js')
    )
  })

  it('uses the unpacked nested entry for packaged apps', () => {
    const appPath = path.join('C:', 'Orca', 'resources', 'app.asar')

    expect(resolveWatcherProcessEntryPath(appPath, true, () => true)).toBe(
      path.join(
        'C:',
        'Orca',
        'resources',
        'app.asar.unpacked',
        'out',
        'main',
        'parcel-watcher-process-entry.js'
      )
    )
  })
})
