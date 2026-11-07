import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  findKeybindingConflicts,
  getEffectiveKeybindingsForAction,
  keybindingMatchesAction
} from '../../shared/keybindings'
import { getUserKeybindingsPath } from './keybinding-file'
import { KeybindingService } from './keybinding-service'

describe('KeybindingService profile defaults', () => {
  let home: string
  const cmdK = { key: 'k', code: 'KeyK', meta: true, control: false, alt: false, shift: false }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-kb-service-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  function open(legacySearchDefaults = false): KeybindingService {
    return new KeybindingService({ homePath: home, platform: 'darwin', legacySearchDefaults })
  }

  function write(document: unknown): void {
    mkdirSync(join(home, '.orca'), { recursive: true })
    writeFileSync(getUserKeybindingsPath(home), JSON.stringify(document))
  }

  it('keeps fresh and older profiles independent across opening order and reloads', () => {
    const fresh = open()
    expect(keybindingMatchesAction('worktree.palette', cmdK, 'darwin', fresh.getOverrides())).toBe(
      true
    )
    const older = open(true)
    expect(keybindingMatchesAction('terminal.clear', cmdK, 'darwin', older.getOverrides())).toBe(
      true
    )
    expect(older.getOverrides()['worktree.palette']).toEqual(['Mod+J'])
    expect(fresh.reload().overrides).toEqual({})
    expect(open().getOverrides()).toEqual({})
    expect(open(true).getOverrides()['terminal.clear']).toEqual(['Mod+K'])
    expect(existsSync(getUserKeybindingsPath(home))).toBe(false)
  })

  it('reconciles inherited clear on reset and keeps that explicit choice across profiles', () => {
    const older = open(true)
    const reset = older.setActionBindings('worktree.palette', null)
    expect(reset.overrides).toEqual({ 'worktree.palette': ['Mod+K'], 'terminal.clear': [] })
    expect(
      findKeybindingConflicts('darwin', reset.overrides, {
        includeMainProcessInterception: true
      })
    ).toEqual([])
    expect(keybindingMatchesAction('terminal.clear', cmdK, 'darwin', reset.overrides)).toBe(false)
    expect(open(true).getOverrides()).toEqual(reset.overrides)
    expect(open().getOverrides()).toEqual({ 'worktree.palette': ['Mod+K'] })
    expect(JSON.parse(readFileSync(getUserKeybindingsPath(home), 'utf8')).platforms.darwin).toEqual(
      {
        'worktree.palette': ['Mod+K']
      }
    )
  })

  it('keeps a reset performed in a fresh profile authoritative for older profiles', () => {
    open().setActionBindings('worktree.palette', null)
    expect(open(true).getOverrides()).toEqual({
      'worktree.palette': ['Mod+K'],
      'terminal.clear': []
    })
  })

  it('preserves explicit clear assignments when search is reset', () => {
    const older = open(true)
    older.setActionBindings('terminal.clear', ['Mod+Alt+K'])
    expect(older.setActionBindings('worktree.palette', null).overrides).toEqual({
      'worktree.palette': ['Mod+K'],
      'terminal.clear': ['Mod+Alt+K']
    })
  })

  it('rejects a reset that conflicts with an explicit clear shortcut without changing it', () => {
    const older = open(true)
    older.setActionBindings('terminal.clear', ['Mod+K'])
    const path = getUserKeybindingsPath(home)
    const before = readFileSync(path, 'utf8')
    expect(() => older.setActionBindings('worktree.palette', null)).toThrow('conflicts')
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(older.reload().overrides).toEqual({
      'worktree.palette': ['Mod+J'],
      'terminal.clear': ['Mod+K']
    })
  })

  it('keeps inherited shortcuts active with malformed JSON and after repair', () => {
    write({})
    const path = getUserKeybindingsPath(home)
    writeFileSync(path, '{invalid')
    const older = open(true)
    expect(older.getOverrides()).toEqual({
      'worktree.palette': ['Mod+J'],
      'terminal.clear': ['Mod+K']
    })
    expect(older.getSnapshot().diagnostics[0].code).toBe('readFailed')
    expect(older.reload().overrides).toEqual(older.getOverrides())
    expect(readFileSync(path, 'utf8')).toBe('{invalid')
    write({ platforms: { darwin: { 'terminal.clear': [] } } })
    expect(older.reload().overrides).toEqual({
      'worktree.palette': ['Mod+J'],
      'terminal.clear': []
    })
  })

  it('uses custom legacy settings in memory when importing fails and retries next launch', () => {
    mkdirSync(join(home, '.orca', 'keybindings.json.tmp'), { recursive: true })
    const options = {
      homePath: home,
      platform: 'darwin' as const,
      legacySearchDefaults: true,
      getLegacyOverrides: () => ({ 'worktree.palette': ['Mod+Alt+J'] })
    }
    const failed = new KeybindingService(options)
    expect(failed.getOverrides()).toEqual({
      'worktree.palette': ['Mod+Alt+J'],
      'terminal.clear': ['Mod+K']
    })
    rmSync(join(home, '.orca', 'keybindings.json.tmp'), { recursive: true })
    expect(new KeybindingService(options).getOverrides()).toEqual({
      'worktree.palette': ['Mod+Alt+J'],
      'terminal.clear': ['Mod+K']
    })
    expect(JSON.parse(readFileSync(getUserKeybindingsPath(home), 'utf8')).platforms.darwin).toEqual(
      {
        'worktree.palette': ['Mod+Alt+J']
      }
    )
  })

  it('persists pending legacy choices together with a new settings edit after recovery', () => {
    mkdirSync(join(home, '.orca', 'keybindings.json.tmp'), { recursive: true })
    const older = new KeybindingService({
      homePath: home,
      platform: 'darwin',
      legacySearchDefaults: true,
      getLegacyOverrides: () => ({ 'worktree.palette': ['Mod+Alt+J'] })
    })
    rmSync(join(home, '.orca', 'keybindings.json.tmp'), { recursive: true })
    expect(older.setActionBindings('view.tasks', ['Ctrl+Alt+T']).overrides).toEqual({
      'worktree.palette': ['Mod+Alt+J'],
      'terminal.clear': ['Mod+K'],
      'view.tasks': ['Ctrl+Alt+T']
    })
    expect(open(true).getOverrides()).toEqual({
      'worktree.palette': ['Mod+Alt+J'],
      'terminal.clear': ['Mod+K'],
      'view.tasks': ['Ctrl+Alt+T']
    })
  })

  it('imports the first explicit legacy choices without leaking generated defaults', () => {
    open(true)
    const older = new KeybindingService({
      homePath: home,
      platform: 'darwin',
      legacySearchDefaults: true,
      getLegacyOverrides: () => ({ 'worktree.palette': ['Cmd+K'], 'view.tasks': ['Ctrl+Alt+T'] })
    })
    expect(older.getOverrides()).toEqual({
      'worktree.palette': ['Cmd+K'],
      'terminal.clear': [],
      'view.tasks': ['Ctrl+Alt+T']
    })
    const another = new KeybindingService({
      homePath: home,
      platform: 'darwin',
      getLegacyOverrides: () => ({ 'view.tasks': ['Ctrl+Alt+X'] })
    })
    expect(another.getOverrides()).toEqual({
      'worktree.palette': ['Cmd+K'],
      'view.tasks': ['Ctrl+Alt+T']
    })
  })

  it('preserves common, disabled and other-platform choices', () => {
    write({
      keybindings: { 'worktree.palette': ['Mod+Alt+J'] },
      platforms: {
        darwin: { 'terminal.clear': [] },
        win32: { 'worktree.palette': ['Mod+Shift+J'] }
      }
    })
    const older = open(true)
    expect(older.getOverrides()).toEqual({
      'worktree.palette': ['Mod+Alt+J'],
      'terminal.clear': []
    })
    older.setActionBindings('worktree.palette', ['Mod+Alt+K'])
    const reset = older.setActionBindings('worktree.palette', null)
    expect(reset.overrides).toEqual({ 'worktree.palette': ['Mod+Alt+J'], 'terminal.clear': [] })
    expect(reset.platformOverrides.win32).toEqual({ 'worktree.palette': ['Mod+Shift+J'] })
  })

  it.each(['linux', 'win32'] as const)(
    'keeps tab defaults local and search unchanged on %s',
    (platform) => {
      const older = new KeybindingService({
        homePath: home,
        platform,
        legacyTabSwitchDefaults: true,
        legacySearchDefaults: true
      })
      expect(older.getOverrides()).toEqual({
        'tab.nextSameType': ['Mod+Shift+BracketRight'],
        'tab.previousSameType': ['Mod+Shift+BracketLeft'],
        'tab.nextAllTypes': ['Mod+Alt+BracketRight'],
        'tab.previousAllTypes': ['Mod+Alt+BracketLeft']
      })
      older.setActionBindings('tab.nextAllTypes', [])
      const reset = older.setActionBindings('tab.nextSameType', null)
      expect(
        getEffectiveKeybindingsForAction('tab.nextSameType', platform, reset.overrides)
      ).toEqual(['Mod+Alt+BracketRight'])
      expect(new KeybindingService({ homePath: home, platform }).getOverrides()).toEqual({
        'tab.nextSameType': ['Mod+Alt+BracketRight'],
        'tab.nextAllTypes': []
      })
    }
  )

  it('yields inherited tab shortcuts to explicit assignments during loads and settings writes', () => {
    write({ platforms: { darwin: { 'tab.previousAllTypes': ['Mod+Shift+BracketLeft'] } } })
    const older = new KeybindingService({
      homePath: home,
      platform: 'darwin',
      legacyTabSwitchDefaults: true
    })
    expect(older.getOverrides()['tab.previousSameType']).toEqual([])
    const changed = older.setActionBindings('tab.nextSameType', ['Mod+Alt+BracketRight'])
    expect(changed.overrides['tab.nextAllTypes']).toEqual([])
    expect(changed.overrides['tab.nextSameType']).toEqual(['Mod+Alt+BracketRight'])
    expect(changed.diagnostics).toEqual([])
  })
})
