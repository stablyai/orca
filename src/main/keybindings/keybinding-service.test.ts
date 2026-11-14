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
    'preserves legacy search and tab defaults on %s',
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
        'tab.previousAllTypes': ['Mod+Alt+BracketLeft'],
        'worktree.palette': ['Mod+Shift+J'],
        'terminal.clear': ['Mod+K']
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

  it.each(['linux', 'win32'] as const)(
    'uses Ctrl+K for new profiles and preserves old shortcuts until reset on %s',
    (platform) => {
      const fresh = new KeybindingService({ homePath: home, platform })
      const older = new KeybindingService({ homePath: home, platform, legacySearchDefaults: true })
      const ctrlK = { key: 'k', code: 'KeyK', meta: false, control: true, alt: false, shift: false }
      expect(
        keybindingMatchesAction('worktree.palette', ctrlK, platform, fresh.getOverrides())
      ).toBe(true)
      expect(keybindingMatchesAction('terminal.clear', ctrlK, platform, older.getOverrides())).toBe(
        true
      )
      expect(
        getEffectiveKeybindingsForAction('worktree.palette', platform, older.getOverrides())
      ).toEqual(['Mod+Shift+J'])
      const reset = older.setActionBindings('worktree.palette', null)
      expect(keybindingMatchesAction('worktree.palette', ctrlK, platform, reset.overrides)).toBe(
        true
      )
      expect(keybindingMatchesAction('terminal.clear', ctrlK, platform, reset.overrides)).toBe(
        false
      )
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

describe('KeybindingService Search shortcut opt-in', () => {
  let home: string
  // Stands in for the profile store's in-memory settings value.
  let stored: 'accepted' | 'dismissed' | null
  const cmdK = { key: 'k', code: 'KeyK', meta: true, control: false, alt: false, shift: false }
  const plugin = { actionId: 'plugin:acme.tools/open' as const, title: 'Open tools' }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-kb-optin-'))
    stored = null
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  function openLegacy(
    options: {
      persist?: (choice: 'accepted' | 'dismissed') => Promise<void>
      pluginBindings?: string[]
      legacyOverrides?: Record<string, string[]>
    } = {}
  ): KeybindingService {
    return new KeybindingService({
      homePath: home,
      platform: 'darwin',
      legacySearchDefaults: true,
      getLegacyOverrides: () => options.legacyOverrides,
      readSearchShortcutChoice: () => stored,
      persistSearchShortcutChoice:
        options.persist ??
        (async (choice) => {
          stored = choice
        }),
      getSearchShortcutPluginOwners: () =>
        options.pluginBindings ? [{ ...plugin, defaultBindings: options.pluginBindings }] : []
    })
  }

  function write(document: unknown): void {
    mkdirSync(join(home, '.orca'), { recursive: true })
    writeFileSync(
      getUserKeybindingsPath(home),
      typeof document === 'string' ? document : JSON.stringify(document)
    )
  }

  const legacy = { 'worktree.palette': ['Mod+J'], 'terminal.clear': ['Mod+K'] }

  it('moves Search to Cmd+K, keeps Cmd+J and custom keys, never writes the file, and undoes exactly', async () => {
    write({
      platforms: { darwin: { 'terminal.clear': ['Mod+Shift+K'], 'tab.close': ['Mod+Shift+F9'] } }
    })
    const before = readFileSync(getUserKeybindingsPath(home), 'utf8')
    const service = openLegacy()

    const accepted = await service.setSearchShortcutChoice('accepted')
    expect(accepted.outcome).toBe('applied')
    expect(
      getEffectiveKeybindingsForAction('worktree.palette', 'darwin', accepted.snapshot.overrides)
    ).toEqual(['Mod+K', 'Mod+J'])
    expect(accepted.snapshot.overrides['terminal.clear']).toEqual(['Mod+Shift+K'])
    expect(accepted.snapshot.overrides['tab.close']).toEqual(['Mod+Shift+F9'])
    expect(readFileSync(getUserKeybindingsPath(home), 'utf8')).toBe(before)
    expect(openLegacy().getOverrides()['worktree.palette']).toEqual(['Mod+K', 'Mod+J'])

    service.setActionBindings('tab.close', ['Mod+Shift+F8'])
    const undone = await service.setSearchShortcutChoice('dismissed')
    expect(undone.snapshot.overrides['worktree.palette']).toEqual(['Mod+J'])
    expect(undone.snapshot.overrides['terminal.clear']).toEqual(['Mod+Shift+K'])
    expect(undone.snapshot.overrides['tab.close']).toEqual(['Mod+Shift+F8'])
    expect(stored).toBe('dismissed')
  })

  it('restores Cmd+K clear on undo when clear has no custom key', async () => {
    const service = openLegacy()
    const { snapshot } = await service.setSearchShortcutChoice('accepted')
    expect(keybindingMatchesAction('terminal.clear', cmdK, 'darwin', snapshot.overrides)).toBe(
      false
    )
    expect((await service.setSearchShortcutChoice('dismissed')).snapshot.overrides).toEqual(legacy)
  })

  it.each([
    [
      'explicit clear on Cmd+K',
      { platforms: { darwin: { 'terminal.clear': ['Mod+K'] } } },
      undefined
    ],
    ['custom Search key', { platforms: { darwin: { 'worktree.palette': ['Mod+P'] } } }, undefined],
    ['plugin manifest key on Cmd+K', {}, ['Mod+K']],
    [
      'plugin override on Cmd+K',
      { platforms: { darwin: { 'plugin:acme.tools/open': ['Mod+K'] } } },
      ['Mod+Shift+F7']
    ],
    ['malformed file', '{ not json', undefined]
  ])('refuses without saving: %s', async (_name, document, pluginBindings) => {
    write(document)
    const service = openLegacy({ pluginBindings })
    const result = await service.setSearchShortcutChoice('accepted')
    expect(result.outcome).toBe('refused')
    expect(stored).toBeNull()
    expect(result.snapshot.overrides['terminal.clear'] ?? []).not.toEqual([])
  })

  it('refuses while a failed legacy import runs on fallback, then allows it after repair and restart', async () => {
    write('{ not json')
    const legacyOverrides = { 'worktree.palette': ['Mod+P'] }
    const service = openLegacy({ legacyOverrides })
    write({})
    expect(service.reload().searchShortcut).toEqual({ choice: null, fileError: true })
    expect((await service.setSearchShortcutChoice('accepted')).outcome).toBe('refused')

    rmSync(getUserKeybindingsPath(home))
    const restarted = openLegacy({ legacyOverrides: {} })
    expect((await restarted.setSearchShortcutChoice('accepted')).outcome).toBe('applied')
  })

  it('keeps legacy shortcuts when the save is rejected before commit', async () => {
    const service = openLegacy({
      persist: async () => {
        throw new Error('disk full')
      }
    })
    const result = await service.setSearchShortcutChoice('accepted')
    expect(result.outcome).toBe('unchanged')
    expect(result.snapshot.overrides).toEqual(legacy)
    expect(openLegacy().getOverrides()).toEqual(legacy)
  })

  it('follows the stored choice when the save fails after committing, including an interrupted undo', async () => {
    const indeterminate = async (choice: 'accepted' | 'dismissed'): Promise<void> => {
      stored = choice
      throw new Error('writer exited before acknowledging')
    }
    const service = openLegacy({ persist: indeterminate })
    const accepted = await service.setSearchShortcutChoice('accepted')
    expect(accepted.outcome).toBe('unconfirmed')
    expect(accepted.snapshot.searchShortcut).toEqual({ choice: 'accepted' })
    expect(accepted.snapshot.overrides['worktree.palette']).toEqual(['Mod+K', 'Mod+J'])
    expect(openLegacy().getOverrides()['worktree.palette']).toEqual(['Mod+K', 'Mod+J'])

    const rejectingUndo = openLegacy({
      persist: async () => {
        throw new Error('disk full')
      }
    })
    const undo = await rejectingUndo.setSearchShortcutChoice('dismissed')
    expect(undo.outcome).toBe('unchanged')
    expect(undo.snapshot.searchShortcut).toEqual({ choice: 'accepted' })
  })

  it('offers nothing to new profiles', async () => {
    const fresh = new KeybindingService({ homePath: home, platform: 'darwin' })
    expect(fresh.getSnapshot().searchShortcut).toBeUndefined()
    expect((await fresh.setSearchShortcutChoice('accepted')).outcome).toBe('refused')
  })
})
