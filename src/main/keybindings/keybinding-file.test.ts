import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getUserKeybindingsPath,
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

  it('resolves the user-facing keybindings path under ~/.orca', () => {
    expect(getUserKeybindingsPath('/home/test')).toBe(
      join('/home/test', '.orca', 'keybindings.json')
    )
  })

  it('returns an empty snapshot when the file does not exist', () => {
    expect(readKeybindingFile(filePath, 'linux')).toMatchObject({
      exists: false,
      platform: 'linux',
      overrides: {},
      diagnostics: []
    })
  })

  it('parses common and platform-specific overrides', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        keybindings: {
          'worktree.quickOpen': 'Mod+Shift+P',
          'view.tasks': null
        },
        platforms: {
          linux: {
            'terminal.paste': ['Ctrl+Shift+V', 'Shift+Insert'],
            'terminal.search': 'Ctrl+Shift+F'
          },
          darwin: {
            'terminal.search': 'Mod+F'
          }
        }
      }),
      'utf8'
    )

    expect(readKeybindingFile(filePath, 'linux')).toMatchObject({
      exists: true,
      overrides: {
        'worktree.quickOpen': ['Mod+Shift+P'],
        'view.tasks': [],
        'terminal.paste': ['Ctrl+Shift+V', 'Shift+Insert'],
        'terminal.search': ['Ctrl+Shift+F']
      },
      diagnostics: []
    })
  })

  it('accepts bare keys for actions that explicitly opt in', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        keybindings: {
          'fileExplorer.delete': 'Delete'
        }
      }),
      'utf8'
    )

    expect(readKeybindingFile(filePath, 'linux')).toMatchObject({
      overrides: {
        'fileExplorer.delete': ['Delete']
      },
      diagnostics: []
    })
  })

  it('ignores invalid, unknown, and conflicting manual edits', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        keybindings: {
          unknownAction: 'Ctrl+Alt+U',
          'terminal.search': 'not-a-keybinding',
          'view.tasks': 'Mod+P'
        }
      }),
      'utf8'
    )

    const snapshot = readKeybindingFile(filePath, 'linux')

    expect(snapshot.overrides).toEqual({})
    expect(snapshot.diagnostics.map((diagnostic) => diagnostic.severity)).toEqual([
      'warning',
      'error',
      'error'
    ])
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

  it('migrates root-level legacy overrides before writing settings edits', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        'worktree.quickOpen': 'Mod+Shift+P',
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
      'worktree.quickOpen'?: unknown
    }
    expect(written['worktree.quickOpen']).toBeUndefined()
    expect(written.keybindings['worktree.quickOpen']).toEqual(['Mod+Shift+P'])
    expect(written.platforms.darwin['terminal.search']).toBe('Mod+F')
    expect(readKeybindingFile(filePath, 'linux').overrides).toEqual({
      'worktree.quickOpen': ['Mod+Shift+P'],
      'terminal.search': ['Ctrl+Shift+F']
    })
  })

  it('rejects writes that would conflict with another effective shortcut', () => {
    expect(() => writeKeybindingOverride(filePath, 'linux', 'view.tasks', ['Mod+P'])).toThrow(
      'conflicts with another shortcut'
    )
    expect(readKeybindingFile(filePath, 'linux').overrides).toEqual({})
  })

  it('validates write inputs at the file boundary', () => {
    expect(() => writeKeybindingOverride(filePath, 'linux', 'unknown.action', [])).toThrow(
      'Unknown keybinding action'
    )
    expect(() => writeKeybindingOverride(filePath, 'linux', 'view.tasks', 'Ctrl+Alt+T')).toThrow(
      'Use a string array or null.'
    )
  })

  it('resets only the active platform override', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        keybindings: {
          'terminal.search': 'Ctrl+Alt+F'
        },
        platforms: {
          linux: {
            'terminal.search': 'Ctrl+Shift+F'
          }
        }
      }),
      'utf8'
    )

    writeKeybindingOverride(filePath, 'linux', 'terminal.search', null)

    const snapshot = readKeybindingFile(filePath, 'linux')
    expect(snapshot.commonOverrides).toEqual({
      'terminal.search': ['Ctrl+Alt+F']
    })
    expect(snapshot.platformOverrides.linux).toEqual({})
    expect(snapshot.overrides).toEqual({
      'terminal.search': ['Ctrl+Alt+F']
    })
  })

  it('migrates legacy settings once when no file exists', () => {
    migrateLegacyKeybindings(filePath, 'linux', { 'view.tasks': ['Ctrl+Alt+T'] })
    migrateLegacyKeybindings(filePath, 'linux', { 'view.tasks': ['Ctrl+Alt+X'] })

    expect(readKeybindingFile(filePath, 'linux').overrides).toEqual({
      'view.tasks': ['Ctrl+Alt+T']
    })
  })
})
