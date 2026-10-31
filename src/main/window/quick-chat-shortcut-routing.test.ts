import { expect, it, vi } from 'vitest'
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    app: { isPackaged: true },
    BrowserWindow: class extends EventEmitter {
      webContents = Object.assign(new EventEmitter(), { send: vi.fn() })
    }
  }
})
import { BrowserWindow } from 'electron'
import { installMainWindowShortcutRouting } from './main-window-shortcut-routing'
import { setupGuestShortcutForwarding } from '../browser/browser-guest-shortcut-forwarding'
import { resolveWindowShortcutAction } from '../../shared/window-shortcut-policy'
import {
  isKeybindingInterceptedByMainProcess,
  KEYBINDING_DEFINITIONS
} from '../../shared/keybindings'

const chord = { code: 'KeyN', key: 'n', meta: true, control: false, alt: true, shift: false }
it('keeps the Mac-only default and allows effective bindings on every platform', () => {
  expect(resolveWindowShortcutAction(chord, 'darwin')).toEqual({ type: 'quickStartChat' })
  for (const platform of ['win32', 'linux'] as const) {
    expect(
      resolveWindowShortcutAction({ ...chord, meta: false, control: true }, platform)
    ).toBeNull()
    expect(
      resolveWindowShortcutAction({ ...chord, meta: false, control: true }, platform, {
        'chat.quickStart': ['Mod+Alt+N']
      })
    ).toEqual({ type: 'quickStartChat' })
  }
  const definition = KEYBINDING_DEFINITIONS.find((row) => row.id === 'chat.quickStart')!
  expect(isKeybindingInterceptedByMainProcess(definition)).toBe(true)
})

it.each(['main', 'floating', 'guest'] as const)(
  'dispatches once to the owning renderer from %s, consumes repeats, excludes composing input, and keeps separate presses',
  (surface) => {
    const mainWindow = new BrowserWindow()
    const guest = new BrowserWindow().webContents
    const keybindings = { 'chat.quickStart': ['Mod+Shift+Q'] }
    let recording = false
    let cleanup = () => {}
    if (surface === 'guest') {
      cleanup = setupGuestShortcutForwarding({
        browserTabId: 'guest',
        guest,
        resolveRenderer: () => mainWindow.webContents,
        getKeybindings: () => keybindings
      })
    } else {
      installMainWindowShortcutRouting({
        mainWindow,
        store: null,
        opts: { getKeybindings: () => keybindings },
        focus: {
          dispose() {},
          notifySystemResume() {},
          isFloatingPanelFocused: () => surface === 'floating',
          isFloatingTerminalInputFocused: () => surface === 'floating',
          isMarkdownEditorFocused: () => false,
          isRendererProcessGone: () => false,
          isShortcutRecorderFocused: () => recording,
          isTerminalInputFocused: () => false
        }
      })
    }
    const target = surface === 'guest' ? guest : mainWindow.webContents
    const send = vi.mocked(mainWindow.webContents.send)
    const input: Electron.Input = {
      type: 'keyDown',
      code: 'KeyQ',
      key: 'q',
      meta: process.platform === 'darwin',
      control: process.platform !== 'darwin',
      alt: false,
      shift: true,
      isAutoRepeat: false,
      isComposing: false,
      location: 0,
      modifiers: []
    }
    const emit = (overrides: Partial<Electron.Input> = {}) => {
      const event = { preventDefault: vi.fn(), defaultPrevented: false }
      target.emit('before-input-event', event, { ...input, ...overrides })
      return event.preventDefault
    }
    expect(emit()).toHaveBeenCalledOnce()
    expect(send.mock.calls.filter(([channel]) => channel === 'ui:quickStartChat')).toHaveLength(1)
    expect(emit({ isAutoRepeat: true })).toHaveBeenCalledOnce()
    expect(send.mock.calls.filter(([channel]) => channel === 'ui:quickStartChat')).toHaveLength(1)
    emit({ isComposing: true })
    expect(send.mock.calls.filter(([channel]) => channel === 'ui:quickStartChat')).toHaveLength(1)
    emit()
    expect(send.mock.calls.filter(([channel]) => channel === 'ui:quickStartChat')).toHaveLength(2)
    if (surface !== 'guest') {
      recording = true
      expect(emit()).not.toHaveBeenCalled()
    }
    cleanup()
    if (surface === 'guest') {
      emit()
      expect(send.mock.calls.filter(([channel]) => channel === 'ui:quickStartChat')).toHaveLength(2)
    }
  }
)
