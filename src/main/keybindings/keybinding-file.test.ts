import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getEffectiveKeybindingsForAction } from '../../shared/keybindings'
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

  describe.each(['darwin', 'linux', 'win32'] as const)(
    'command palette defaults on %s',
    (platform) => {
      it.each(['root', 'common', 'platform'] as const)(
        'preserves an existing F1 shortcut in the %s section without rewriting the file',
        (section) => {
          const bindings = { 'editor.nextChange': ['f1'] }
          const documents = {
            root: bindings,
            common: { keybindings: bindings },
            platform: { platforms: { [platform]: bindings } }
          }
          const contents = JSON.stringify(documents[section])
          writeFileSync(filePath, contents, 'utf8')

          const snapshot = readKeybindingFile(filePath, platform)

          expect(snapshot.overrides).toEqual({ 'editor.nextChange': ['F1'] })
          expect(snapshot.diagnostics).toEqual([])
          expect(
            getEffectiveKeybindingsForAction('editor.commandPalette', platform, snapshot.overrides)
          ).toEqual([])
          expect(readFileSync(filePath, 'utf8')).toBe(contents)
        }
      )

      it('allows assigning F1 in Settings and restores the palette default after reset', () => {
        const assigned = writeKeybindingOverride(filePath, platform, 'editor.nextChange', ['F1'])

        expect(assigned.overrides).toEqual({ 'editor.nextChange': ['F1'] })
        expect(assigned.diagnostics).toEqual([])
        expect(
          getEffectiveKeybindingsForAction('editor.commandPalette', platform, assigned.overrides)
        ).toEqual([])

        const reset = writeKeybindingOverride(filePath, platform, 'editor.nextChange', null)

        expect(reset.overrides).toEqual({})
        expect(reset.diagnostics).toEqual([])
        expect(
          getEffectiveKeybindingsForAction('editor.commandPalette', platform, reset.overrides)
        ).toEqual(['F1'])
      })

      it.each([{ bindings: [] }, { bindings: ['F2'] }])(
        'preserves an explicit palette binding of $bindings alongside an editor F1 shortcut',
        ({ bindings }) => {
          writeKeybindingOverride(filePath, platform, 'editor.commandPalette', bindings)
          const snapshot = writeKeybindingOverride(filePath, platform, 'editor.nextChange', ['F1'])

          expect(snapshot.diagnostics).toEqual([])
          expect(snapshot.overrides['editor.nextChange']).toEqual(['F1'])
          expect(
            getEffectiveKeybindingsForAction('editor.commandPalette', platform, snapshot.overrides)
          ).toEqual(bindings)
        }
      )

      it('still rejects a conflict when the user explicitly assigns F1 to the palette', () => {
        writeKeybindingOverride(filePath, platform, 'editor.commandPalette', ['F1'])

        expect(() =>
          writeKeybindingOverride(filePath, platform, 'editor.nextChange', ['F1'])
        ).toThrow('conflicts with another shortcut')
      })

      it.each([
        { actionId: 'fileExplorer.delete', binding: 'F1' },
        { actionId: 'editor.previousChange', binding: 'Shift+F1' }
      ] as const)('keeps palette F1 when $actionId uses $binding', ({ actionId, binding }) => {
        const snapshot = writeKeybindingOverride(filePath, platform, actionId, [binding])

        expect(snapshot.diagnostics).toEqual([])
        expect(snapshot.overrides[actionId]).toEqual([binding])
        expect(
          getEffectiveKeybindingsForAction('editor.commandPalette', platform, snapshot.overrides)
        ).toEqual(['F1'])
      })
    }
  )

  it('uses the active platform override when deciding whether editor F1 is available', () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        keybindings: { 'editor.nextChange': ['F1'] },
        platforms: { linux: { 'editor.nextChange': ['F2'] } }
      }),
      'utf8'
    )

    const linux = readKeybindingFile(filePath, 'linux')
    const darwin = readKeybindingFile(filePath, 'darwin')

    expect(linux.overrides).toEqual({ 'editor.nextChange': ['F2'] })
    expect(darwin.overrides).toEqual({ 'editor.nextChange': ['F1'] })
    expect(
      getEffectiveKeybindingsForAction('editor.commandPalette', 'linux', linux.overrides)
    ).toEqual(['F1'])
    expect(
      getEffectiveKeybindingsForAction('editor.commandPalette', 'darwin', darwin.overrides)
    ).toEqual([])
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
