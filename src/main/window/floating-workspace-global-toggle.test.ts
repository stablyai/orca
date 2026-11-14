import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { KeybindingOverrides } from '../../shared/keybindings'
import type { Store } from '../persistence/loading-store/store'
import type * as GlobalToggle from './floating-workspace-global-toggle'

const electron = vi.hoisted(() => {
  const appHandlers = new Map<string, () => void>()
  return {
    appHandlers,
    app: {
      on: vi.fn((event: string, handler: () => void) => appHandlers.set(event, handler)),
      once: vi.fn((event: string, handler: () => void) => appHandlers.set(event, handler)),
      off: vi.fn()
    },
    globalShortcut: {
      register: vi.fn((_accelerator: string, _onPress: () => void) => true),
      unregister: vi.fn()
    },
    send: vi.fn(),
    summon: vi.fn(() => false),
    requestPlacement: vi.fn(),
    background: { value: false },
    quittingForUpdate: { value: false }
  }
})

vi.mock('electron', () => ({ app: electron.app, globalShortcut: electron.globalShortcut }))
vi.mock('../ipc/ui', () => ({
  getTrustedUIRendererWebContents: () => ({ id: 1 }),
  sendToTrustedUIRenderer: electron.send
}))
vi.mock('../updater/updater-service', () => ({
  isQuittingForUpdate: () => electron.quittingForUpdate.value
}))
vi.mock('./floating-workspace-window', () => ({
  summonFloatingWorkspaceWindow: electron.summon,
  requestFloatingWorkspaceWindowPlacement: electron.requestPlacement
}))
vi.mock('./activation/foreground-activation-policy', () => ({
  isBackgroundLaunch: () => electron.background.value
}))

import {
  bindingToGlobalAccelerator,
  floatingToggleGlobalAccelerator
} from './floating-workspace-global-toggle'

const DEFAULT_CHORD = 'CommandOrControl+Alt+A'

describe('Floating Workspace global accelerator', () => {
  it('maps the default chord on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(floatingToggleGlobalAccelerator(platform, undefined)).toBe('CommandOrControl+Alt+A')
    }
  })

  it('never registers a chord without a non-Shift modifier, a double tap or an unsupported key', () => {
    expect(bindingToGlobalAccelerator('A', 'darwin')).toBeNull()
    expect(bindingToGlobalAccelerator('Shift+A', 'darwin')).toBeNull()
    expect(bindingToGlobalAccelerator('DoubleTap+Shift', 'darwin')).toBeNull()
    expect(bindingToGlobalAccelerator('Mod+ArrowUp', 'darwin')).toBeNull()
  })

  it('keeps Cmd distinct from Ctrl and skips bindings it cannot register', () => {
    expect(bindingToGlobalAccelerator('Cmd+Shift+F5', 'darwin')).toBe('Command+Shift+F5')
    expect(bindingToGlobalAccelerator('Cmd+Space', 'linux')).toBe('Super+Space')
    expect(
      floatingToggleGlobalAccelerator('darwin', {
        'floatingTerminal.toggle': ['DoubleTap+Alt', 'Ctrl+Alt+9']
      })
    ).toBe('Control+Alt+9')
  })
})

describe('Floating Workspace global chord', () => {
  let settings: GlobalSettings
  let overrides: KeybindingOverrides
  let mainWindow: boolean
  let quitting: boolean
  let settingsListener: Parameters<Store['onSettingsChanged']>[0]
  let keybindingListener: () => void

  async function install(): Promise<typeof GlobalToggle> {
    const toggle = await import('./floating-workspace-global-toggle')
    toggle.installFloatingWorkspaceGlobalToggle({
      store: {
        getSettings: () => settings,
        onSettingsChanged: (listener) => {
          settingsListener = listener
          return () => undefined
        }
      },
      keybindings: {
        getOverrides: () => overrides,
        onChange: (listener) => {
          keybindingListener = listener
          return () => undefined
        }
      },
      getIsQuitting: () => quitting,
      hasMainWindow: () => mainWindow
    })
    return toggle
  }

  function pressRegisteredChord(): void {
    const onPress = electron.globalShortcut.register.mock.calls.at(-1)?.[1]
    onPress?.()
  }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useFakeTimers()
    electron.globalShortcut.register.mockImplementation(() => true)
    electron.summon.mockReturnValue(false)
    electron.background.value = false
    electron.quittingForUpdate.value = false
    settings = {
      ...getDefaultSettings('/test'),
      floatingTerminalEnabled: true,
      experimentalFloatingWorkspacePopout: true,
      experimentalFloatingWorkspaceMode: 'popout'
    }
    overrides = {}
    mainWindow = true
    quitting = false
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds the chord only in Pop-out mode with a main window, never in a background launch', async () => {
    settings.experimentalFloatingWorkspaceMode = 'in-window'
    const toggle = await install()
    expect(electron.globalShortcut.register).not.toHaveBeenCalled()

    settings.experimentalFloatingWorkspaceMode = 'popout'
    settingsListener({}, settings)
    expect(electron.globalShortcut.register).toHaveBeenCalledWith(
      DEFAULT_CHORD,
      expect.any(Function)
    )

    mainWindow = false
    toggle.syncFloatingWorkspaceGlobalToggle()
    expect(electron.globalShortcut.unregister).toHaveBeenCalledWith(DEFAULT_CHORD)

    vi.resetModules()
    vi.clearAllMocks()
    mainWindow = true
    electron.background.value = true
    await install()
    expect(electron.globalShortcut.register).not.toHaveBeenCalled()
  })

  it('a rebind swaps only its own chord; a chord another app holds warns once and is retried', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    electron.globalShortcut.register.mockImplementation(() => false)
    const toggle = await install()
    toggle.syncFloatingWorkspaceGlobalToggle()
    expect(electron.globalShortcut.register).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(electron.globalShortcut.unregister).not.toHaveBeenCalled()

    electron.globalShortcut.register.mockImplementation(() => true)
    toggle.syncFloatingWorkspaceGlobalToggle()
    overrides = { 'floatingTerminal.toggle': ['Ctrl+Alt+9'] }
    keybindingListener()
    expect(electron.globalShortcut.unregister).toHaveBeenCalledTimes(1)
    expect(electron.globalShortcut.unregister).toHaveBeenCalledWith(DEFAULT_CHORD)
    expect(electron.globalShortcut.register).toHaveBeenLastCalledWith(
      'Control+Alt+9',
      expect.any(Function)
    )
    warn.mockRestore()
  })

  it('quit drops the chord, a late sync during quit leaves it dropped, and a cancelled quit restores it', async () => {
    const toggle = await install()
    electron.appHandlers.get('before-quit')?.()
    expect(electron.globalShortcut.unregister).toHaveBeenCalledWith(DEFAULT_CHORD)

    quitting = true
    electron.globalShortcut.register.mockClear()
    settingsListener({}, settings)
    expect(electron.globalShortcut.register).not.toHaveBeenCalled()

    quitting = false
    toggle.syncFloatingWorkspaceGlobalToggle()
    expect(electron.globalShortcut.register).toHaveBeenCalledWith(
      DEFAULT_CHORD,
      expect.any(Function)
    )
  })

  it('a press summons an open window without a toggle, else toggles once with placement; a repeat within 300 ms is dropped', async () => {
    await install()
    electron.summon.mockReturnValueOnce(true)
    pressRegisteredChord()
    expect(electron.send).not.toHaveBeenCalled()

    vi.advanceTimersByTime(301)
    pressRegisteredChord()
    expect(electron.requestPlacement).toHaveBeenCalledTimes(1)
    expect(electron.send).toHaveBeenCalledWith('ui:toggleFloatingTerminal', null)

    vi.advanceTimersByTime(100)
    pressRegisteredChord()
    expect(electron.send).toHaveBeenCalledTimes(1)
    expect(electron.summon).toHaveBeenCalledTimes(2)
  })
})
