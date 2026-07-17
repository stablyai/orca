import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { GlobalHotkeyManager } from './global-hotkey-manager'
import type { Store } from '../persistence'

const registerMock = vi.fn<(accelerator: string, callback: () => void) => boolean>()
const unregisterMock = vi.fn<(accelerator: string) => void>()
const appHideMock = vi.fn()

vi.mock('electron', () => ({
  app: {
    hide: (...args: unknown[]) => appHideMock(...args),
    focus: vi.fn(),
    isReady: () => true
  },
  globalShortcut: {
    register: (accelerator: string, callback: () => void) => registerMock(accelerator, callback),
    unregister: (accelerator: string) => unregisterMock(accelerator)
  }
}))

const focusExistingMainWindowMock = vi.fn()
vi.mock('../window/focus-existing-window', () => ({
  focusExistingMainWindow: (...args: unknown[]) => focusExistingMainWindowMock(...args)
}))

type SettingsListener = (updates: Record<string, unknown>) => void

function createStoreFake(globalHotkey: string | undefined): {
  store: Store
  emitSettingsChange: (updates: Record<string, unknown>) => void
  unsubscribed: () => boolean
} {
  const state = { listener: null as SettingsListener | null, unsubscribed: false }
  const store = {
    getSettings: () => ({ globalHotkey }),
    onSettingsChanged: (listener: SettingsListener) => {
      state.listener = listener
      return () => {
        state.unsubscribed = true
        state.listener = null
      }
    }
  } as unknown as Store
  return {
    store,
    emitSettingsChange: (updates) => state.listener?.(updates),
    unsubscribed: () => state.unsubscribed
  }
}

function createWindowFake(options: { visible?: boolean; focused?: boolean; destroyed?: boolean }) {
  return {
    isDestroyed: () => options.destroyed ?? false,
    isVisible: () => options.visible ?? true,
    isFocused: () => options.focused ?? true,
    hide: vi.fn()
  }
}

function createManager(options: {
  globalHotkey?: string
  window?: ReturnType<typeof createWindowFake> | null
  warn?: (message: string, error?: unknown) => void
}) {
  const storeFake = createStoreFake(options.globalHotkey)
  const manager = new GlobalHotkeyManager({
    store: storeFake.store,
    getMainWindow: () => (options.window ?? null) as unknown as BrowserWindow | null,
    openMainWindow: () => (options.window ?? createWindowFake({})) as unknown as BrowserWindow,
    warn: options.warn
  })
  return { manager, ...storeFake }
}

beforeEach(() => {
  registerMock.mockReset()
  registerMock.mockReturnValue(true)
  unregisterMock.mockReset()
  appHideMock.mockReset()
  focusExistingMainWindowMock.mockReset()
})

describe('GlobalHotkeyManager', () => {
  it('registers the configured accelerator on start', () => {
    const { manager } = createManager({ globalHotkey: 'Alt+Space' })
    manager.start()
    expect(registerMock).toHaveBeenCalledTimes(1)
    expect(registerMock).toHaveBeenCalledWith('Alt+Space', expect.any(Function))
  })

  it('does not register anything when the setting is empty or unset', () => {
    const empty = createManager({ globalHotkey: '' })
    empty.manager.start()
    const unset = createManager({})
    unset.manager.start()
    expect(registerMock).not.toHaveBeenCalled()
  })

  it('re-registers when the setting changes and unregisters the old accelerator', () => {
    const { manager, emitSettingsChange } = createManager({ globalHotkey: 'Alt+Space' })
    manager.start()
    emitSettingsChange({ globalHotkey: 'Super+K' })
    expect(unregisterMock).toHaveBeenCalledWith('Alt+Space')
    expect(registerMock).toHaveBeenLastCalledWith('Super+K', expect.any(Function))
  })

  it('unregisters without re-registering when the setting is cleared', () => {
    const { manager, emitSettingsChange } = createManager({ globalHotkey: 'Alt+Space' })
    manager.start()
    registerMock.mockClear()
    emitSettingsChange({ globalHotkey: '' })
    expect(unregisterMock).toHaveBeenCalledWith('Alt+Space')
    expect(registerMock).not.toHaveBeenCalled()
  })

  it('ignores settings changes that do not touch the hotkey', () => {
    const { manager, emitSettingsChange } = createManager({ globalHotkey: 'Alt+Space' })
    manager.start()
    registerMock.mockClear()
    emitSettingsChange({ theme: 'dark' })
    expect(registerMock).not.toHaveBeenCalled()
    expect(unregisterMock).not.toHaveBeenCalled()
  })

  it('warns and keeps no binding when registration is rejected', () => {
    const warn = vi.fn()
    registerMock.mockReturnValue(false)
    const { manager, emitSettingsChange } = createManager({ globalHotkey: 'Alt+Space', warn })
    manager.start()
    expect(warn).toHaveBeenCalledTimes(1)
    // A rejected registration must not be unregistered later.
    emitSettingsChange({ globalHotkey: 'Super+K' })
    expect(unregisterMock).not.toHaveBeenCalled()
  })

  it('warns instead of throwing when registration throws', () => {
    const warn = vi.fn()
    registerMock.mockImplementation(() => {
      throw new Error('bad accelerator')
    })
    const { manager } = createManager({ globalHotkey: 'not an accelerator', warn })
    expect(() => manager.start()).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('treats a non-string persisted value as disabled instead of throwing', () => {
    const { manager } = createManager({ globalHotkey: 12345 as unknown as string })
    expect(() => manager.start()).not.toThrow()
    expect(registerMock).not.toHaveBeenCalled()
  })

  it('stop() unregisters and stops listening for settings changes', () => {
    const { manager, emitSettingsChange, unsubscribed } = createManager({
      globalHotkey: 'Alt+Space'
    })
    manager.start()
    manager.stop()
    expect(unregisterMock).toHaveBeenCalledWith('Alt+Space')
    expect(unsubscribed()).toBe(true)
    registerMock.mockClear()
    emitSettingsChange({ globalHotkey: 'Super+K' })
    expect(registerMock).not.toHaveBeenCalled()
  })

  it('hides a visible focused window when the hotkey fires', () => {
    const window = createWindowFake({ visible: true, focused: true })
    const { manager } = createManager({ globalHotkey: 'Alt+Space', window })
    manager.start()
    const hotkeyCallback = registerMock.mock.calls[0]![1]
    hotkeyCallback()
    expect(window.hide).toHaveBeenCalledTimes(1)
    expect(appHideMock).toHaveBeenCalledTimes(1)
    expect(focusExistingMainWindowMock).not.toHaveBeenCalled()
  })

  it('focuses the window when it is visible but not focused', () => {
    const window = createWindowFake({ visible: true, focused: false })
    const { manager } = createManager({ globalHotkey: 'Alt+Space', window })
    manager.start()
    const hotkeyCallback = registerMock.mock.calls[0]![1]
    hotkeyCallback()
    expect(window.hide).not.toHaveBeenCalled()
    expect(focusExistingMainWindowMock).toHaveBeenCalledTimes(1)
  })

  it('opens/reveals the window when none exists', () => {
    const { manager } = createManager({ globalHotkey: 'Alt+Space', window: null })
    manager.start()
    const hotkeyCallback = registerMock.mock.calls[0]![1]
    hotkeyCallback()
    expect(focusExistingMainWindowMock).toHaveBeenCalledTimes(1)
  })
})
