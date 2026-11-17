import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  migrateLegacyKeybindings,
  readKeybindingFile,
  writeKeybindingOverride
} from './keybinding-file'

describe('keybinding-file', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-keybindings-'))
    filePath = join(dir, 'keybindings.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes active-platform overrides while preserving other platforms', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        keybindings: {
          'worktree.quickOpen': 'Mod+Shift+P'
        },
        platforms: {
          darwin: {
            'terminal.search': 'Mod+F'
          }
        }
      }),
      'utf8'
    )

    writeKeybindingOverride(filePath, 'linux', 'terminal.search', ['Ctrl+Shift+F'])

    const written = JSON.parse(readFileSync(filePath, 'utf8')) as {
      keybindings: Record<string, unknown>
      platforms: Record<string, Record<string, unknown>>
    }
    expect(written.keybindings['worktree.quickOpen']).toBe('Mod+Shift+P')
    expect(written.platforms.darwin['terminal.search']).toBe('Mod+F')
    expect(written.platforms.linux['terminal.search']).toEqual(['Ctrl+Shift+F'])
  })

  it('migrates legacy settings once when no file exists', () => {
    migrateLegacyKeybindings(filePath, 'linux', { 'view.tasks': ['Ctrl+Alt+T'] })
    migrateLegacyKeybindings(filePath, 'linux', { 'view.tasks': ['Ctrl+Alt+X'] })

    expect(readKeybindingFile(filePath, 'linux').overrides).toEqual({
      'view.tasks': ['Ctrl+Alt+T']
    })
  })

  it.each(['darwin', 'linux', 'win32'] as const)(
    'does not reimport a manually deleted shortcut on %s',
    (platform) => {
      migrateLegacyKeybindings(filePath, platform, { 'view.tasks': ['Ctrl+Alt+T'] })
      const document: { platforms: Record<string, Record<string, unknown>> } = JSON.parse(
        readFileSync(filePath, 'utf8')
      )
      delete document.platforms[platform]['view.tasks']
      writeFileSync(filePath, JSON.stringify(document))

      migrateLegacyKeybindings(filePath, platform, { 'view.tasks': ['Ctrl+Alt+T'] })

      expect(readKeybindingFile(filePath, platform).overrides).toEqual({})
    }
  )
})
