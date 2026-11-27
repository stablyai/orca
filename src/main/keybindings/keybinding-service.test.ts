import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getEffectiveKeybindingsForAction } from '../../shared/keybindings/effective'
import { keybindingMatchesAction } from '../../shared/keybindings/matching'
import { getUserKeybindingsPath } from './keybinding-file'
import { KeybindingService } from './keybinding-service'
import { toSearchShortcutPluginOwners } from '../../shared/keybindings/search-shortcut-plugin-owners'
import { planSearchShortcutOptInForSnapshot } from '../../shared/keybindings/search-shortcut-opt-in'

describe('KeybindingService Search shortcut opt-in', () => {
  let home: string
  // Stands in for the profile store's in-memory settings value.
  let stored: 'accepted' | 'dismissed' | null
  const cmdK = { key: 'k', code: 'KeyK', meta: true, control: false, alt: false, shift: false }
  // Active plugin command keys; null means no plugin command is registered.
  let pluginKeys: string[] | null

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-kb-optin-'))
    stored = null
    pluginKeys = null
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
    if (options.pluginBindings) {
      pluginKeys = options.pluginBindings
    }
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
        toSearchShortcutPluginOwners(
          pluginKeys
            ? [
                {
                  pluginKey: 'acme.tools',
                  id: 'open',
                  title: 'Open tools',
                  keybindings: pluginKeys.map((key) => ({ key }))
                }
              ]
            : []
        )
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
    [
      'plugin with no manifest key assigned Cmd+K',
      { platforms: { darwin: { 'plugin:acme.tools/open': ['Mod+K'] } } },
      []
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

  it('clears the import-fallback flag in the snapshot returned by the write that persisted it', async () => {
    write('{ not json')
    const service = openLegacy({ legacyOverrides: { 'tab.close': ['Mod+Shift+F9'] } })
    write({})
    expect(service.reload().searchShortcut?.fileError).toBe(true)
    const written = service.setActionBindings('tab.close', ['Mod+Shift+F8'])
    expect(written.searchShortcut).toEqual({ choice: null })
    expect((await service.setSearchShortcutChoice('accepted')).outcome).toBe('applied')
  })

  it.each([
    [
      'an explicit Cmd+K action edit',
      (service: KeybindingService) => {
        service.setActionBindings('terminal.clear', ['Mod+K'])
      }
    ],
    [
      'a plugin registered on Cmd+K',
      () => {
        pluginKeys = ['Mod+K']
      }
    ]
  ])('reports superseded and keeps %s that lands during the save', async (_name, edit) => {
    let release: () => void = () => undefined
    let service: KeybindingService | null = null
    service = openLegacy({
      persist: (choice) =>
        new Promise<void>((resolve) => {
          release = () => {
            stored = choice
            resolve()
          }
        })
    })
    const pending = service.setSearchShortcutChoice('accepted')
    await Promise.resolve()
    await Promise.resolve()
    edit(service)
    release()
    const result = await pending
    expect(result.outcome).toBe('superseded')
    expect(result.snapshot.searchShortcut).toEqual({ choice: 'accepted' })
    if (pluginKeys === null) {
      expect(result.snapshot.overrides['terminal.clear']).toEqual(['Mod+K'])
      expect(result.snapshot.overrides['worktree.palette']).toEqual(['Mod+J'])
    }
  })

  it('claims nothing after an indeterminate save that an edit overtook, and plans from live bindings', async () => {
    let release: () => void = () => undefined
    const service = openLegacy({
      persist: (choice) =>
        new Promise<void>((_resolve, reject) => {
          release = () => {
            stored = choice
            reject(new Error('writer exited before acknowledging'))
          }
        })
    })
    const pending = service.setSearchShortcutChoice('accepted')
    await Promise.resolve()
    await Promise.resolve()
    service.setActionBindings('terminal.clear', ['Mod+K'])
    release()
    const result = await pending
    expect(result.outcome).toBe('unconfirmed')
    expect(planSearchShortcutOptInForSnapshot(result.snapshot)).toEqual({
      kind: 'accepted',
      searchOnModK: false,
      owners: [{ actionId: 'terminal.clear' }]
    })
  })

  it('judges an accepted choice from live bindings while the file is unreadable', async () => {
    stored = 'accepted'
    write('{ not json')
    const service = openLegacy({ legacyOverrides: { 'worktree.palette': ['Mod+P'] } })
    const snapshot = service.reload()
    expect(snapshot.overrides['worktree.palette']).toEqual(['Mod+P'])
    expect(planSearchShortcutOptInForSnapshot(snapshot)).toEqual({
      kind: 'accepted',
      searchOnModK: false,
      owners: []
    })

    write('{ not json')
    const clean = openLegacy()
    expect(
      planSearchShortcutOptInForSnapshot(clean.reload(), [
        { actionId: 'plugin:acme.tools/open', title: 'Open tools', defaultBindings: ['Mod+K'] }
      ])
    ).toEqual({
      kind: 'accepted',
      searchOnModK: true,
      owners: [{ actionId: 'plugin:acme.tools/open', title: 'Open tools' }]
    })
  })

  it('lists a core owner of Cmd+K even when a hand-edited file also gives Search Cmd+K', () => {
    stored = 'accepted'
    write({ platforms: { darwin: { 'worktree.palette': ['Mod+K'], 'terminal.clear': ['Mod+K'] } } })
    const snapshot = openLegacy().reload()
    expect(planSearchShortcutOptInForSnapshot(snapshot)).toEqual({
      kind: 'accepted',
      searchOnModK: true,
      owners: [{ actionId: 'terminal.clear' }]
    })
  })

  it('promises the legacy Search chord only when the opt-in keeps it', () => {
    expect(planSearchShortcutOptInForSnapshot(openLegacy().reload())).toEqual({
      kind: 'eligible',
      keepsLegacyKey: true
    })
    write({ platforms: { darwin: { 'tab.close': ['Mod+J'] } } })
    expect(planSearchShortcutOptInForSnapshot(openLegacy().reload())).toEqual({
      kind: 'eligible',
      keepsLegacyKey: false
    })
  })

  it('saves again before reporting a repeated request after an unconfirmed save', async () => {
    const saves: string[] = []
    let failNext = true
    const service = openLegacy({
      persist: async (choice) => {
        saves.push(choice)
        stored = choice
        if (failNext) {
          failNext = false
          throw new Error('writer exited before acknowledging')
        }
      }
    })
    expect((await service.setSearchShortcutChoice('accepted')).outcome).toBe('unconfirmed')
    expect((await service.setSearchShortcutChoice('accepted')).outcome).toBe('applied')
    expect(saves).toEqual(['accepted', 'accepted'])
    expect((await service.setSearchShortcutChoice('accepted')).outcome).toBe('applied')
    expect(saves).toEqual(['accepted', 'accepted'])
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
