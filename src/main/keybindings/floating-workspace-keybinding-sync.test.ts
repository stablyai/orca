import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import type { KeybindingFileSnapshot } from '../../shared/keybindings/types'
import { resolveWindowShortcutAction } from '../../shared/keybindings/window-shortcut-policy'
import { KeybindingService } from './keybinding-service'
import { getUserKeybindingsPath } from './keybinding-file'
import { installFloatingWorkspaceKeybindingSync } from './floating-workspace-keybinding-sync'

const MOD_ALT_A = { type: 'keyDown', key: 'a', code: 'KeyA', meta: true, alt: true }
const EXISTING_ON = { floatingWorkspaceInSettings: true, floatingTerminalEnabled: true }
const EXISTING_OFF = { floatingWorkspaceInSettings: true, floatingTerminalEnabled: false }

let homePath = ''

class FlakyKeybindingService extends KeybindingService {
  failReloads = false

  override reload(): KeybindingFileSnapshot {
    if (this.failReloads) {
      throw new Error('disk unavailable')
    }
    return super.reload()
  }
}

function harness(initial: Partial<GlobalSettings>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sync reads only the two floating keys.
  let settings = { ...initial } as GlobalSettings
  const listeners: ((updates: Partial<GlobalSettings>, next: GlobalSettings) => void)[] = []
  const keybindings = new FlakyKeybindingService({
    homePath,
    platform: 'darwin',
    getFloatingWorkspaceShortcutsActive: () =>
      settings.floatingWorkspaceInSettings === true && settings.floatingTerminalEnabled === true
  })
  const broadcasts: KeybindingFileSnapshot[] = []
  const reconcile = vi.fn()
  const stop = installFloatingWorkspaceKeybindingSync({
    store: {
      onSettingsChanged: (listener) => {
        listeners.push(listener)
        return () => listeners.splice(listeners.indexOf(listener), 1)
      }
    },
    keybindings,
    broadcast: (snapshot) => broadcasts.push(snapshot),
    onChanged: reconcile
  })
  // Same order as main: the store notifies every listener synchronously inside updateSettings.
  const setEnabled = (enabled: boolean) => {
    settings = { ...settings, floatingTerminalEnabled: enabled }
    for (const listener of listeners.slice()) {
      listener({ floatingTerminalEnabled: enabled }, settings)
    }
  }
  // What main-window routing and guests do: map first, then the predicate committed with it.
  const routedAction = () =>
    resolveWindowShortcutAction(MOD_ALT_A, 'darwin', keybindings.getOverrides(), {
      floatingWorkspaceShortcutsActive: keybindings.committedFloatingWorkspaceShortcutsActive()
    })
  return { keybindings, broadcasts, reconcile, setEnabled, routedAction, stop, listeners }
}

describe('floating workspace keybinding sync', () => {
  beforeEach(() => {
    homePath = mkdtempSync(join(tmpdir(), 'orca-floating-sync-'))
    const path = getUserKeybindingsPath(homePath)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({ version: 1, keybindings: { 'tab.newTerminal': ['Mod+Alt+Shift+F9'] } })
    )
  })

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true })
  })

  it('fails closed on a later reload failure and recovers on the next flip', () => {
    const h = harness(EXISTING_OFF)
    expect(h.keybindings.getSnapshot().floatingWorkspaceShortcutsActive).toBe(false)

    h.keybindings.failReloads = true
    expect(() => h.setEnabled(true)).not.toThrow()
    const fallback = h.broadcasts.at(-1)
    expect(fallback?.floatingWorkspaceShortcutsActive).toBe(false)
    expect(fallback?.overrides['tab.newTerminal']).toEqual(['Mod+Alt+Shift+F9'])
    expect(h.keybindings.getSnapshot()).toBe(fallback)
    // Settings say on, but the committed snapshot is inert, so main does not take the chord.
    expect(h.routedAction()).toBeNull()
    expect(h.reconcile).toHaveBeenCalledTimes(1)

    h.keybindings.failReloads = false
    h.setEnabled(false)
    expect(h.broadcasts).toHaveLength(1)
    h.setEnabled(true)
    expect(h.broadcasts.at(-1)?.floatingWorkspaceShortcutsActive).toBe(true)
    expect(h.routedAction()).toEqual({ type: 'toggleFloatingTerminal' })
  })

  it('recovers through a plain reload after a failed enable', () => {
    const h = harness(EXISTING_OFF)
    h.keybindings.getSnapshot()
    h.keybindings.failReloads = true
    h.setEnabled(true)
    expect(h.keybindings.committedFloatingWorkspaceShortcutsActive()).toBe(false)
    h.keybindings.failReloads = false
    expect(h.keybindings.reload().floatingWorkspaceShortcutsActive).toBe(true)
    expect(h.routedAction()).toEqual({ type: 'toggleFloatingTerminal' })
  })

  it('publishes an in-memory inert snapshot when nothing ever loaded', () => {
    const h = harness(EXISTING_OFF)
    h.keybindings.failReloads = true
    expect(() => h.setEnabled(true)).not.toThrow()
    const fallback = h.broadcasts.at(-1)
    // Built without reading the file: the user's binding on disk is not in it.
    expect(fallback?.exists).toBe(false)
    expect(fallback?.overrides['tab.newTerminal']).toBeUndefined()
    expect(fallback?.floatingWorkspaceShortcutsActive).toBe(false)
    expect(h.routedAction()).toBeNull()
  })

  it('stops listening when its unsubscribe runs', () => {
    const h = harness(EXISTING_ON)
    h.stop()
    expect(h.listeners).toHaveLength(0)
  })
})
