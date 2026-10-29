import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveFilesystemHostEntryPath } from './filesystem-host-entry-path'

describe('resolveFilesystemHostEntryPath', () => {
  it('uses the adjacent electron-vite output in development', () => {
    const appPath = join('build', 'out', 'main')
    const adjacent = join(appPath, 'filesystem-host-entry.js')

    expect(resolveFilesystemHostEntryPath(appPath, false, (path) => path === adjacent)).toBe(
      adjacent
    )
  })

  it('uses the asar-unpacked entry in packaged apps', () => {
    expect(resolveFilesystemHostEntryPath(join('Resources', 'app.asar'), true)).toBe(
      join('Resources', 'app.asar.unpacked', 'out', 'main', 'filesystem-host-entry.js')
    )
  })

  it('only replaces the terminal app.asar path segment', () => {
    const appPath = join('app.asar-cache', 'Resources', 'app.asar')

    expect(resolveFilesystemHostEntryPath(appPath, true)).toBe(
      join(
        'app.asar-cache',
        'Resources',
        'app.asar.unpacked',
        'out',
        'main',
        'filesystem-host-entry.js'
      )
    )
  })
})
