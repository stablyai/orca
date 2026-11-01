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
it.each([
  { label: 'recorded C3 lowercase', key: 'n', modifierSequence: false },
  { label: 'C5 Playwright sequence inferred from source', key: 'N', modifierSequence: true },
  { label: 'Mac Option Dead contract probe', key: 'Dead', modifierSequence: false },
  { label: 'Mac Option composed contract probe', key: '˜', modifierSequence: false }
])('forwards the default guest chord once for $label', ({ key, modifierSequence }) => {
  const originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  const renderer = new BrowserWindow().webContents
  const guest = new BrowserWindow().webContents
  const cleanup = setupGuestShortcutForwarding({
    browserTabId: 'guest',
    guest,
    resolveRenderer: () => renderer
  })
  const input: Electron.Input = {
    ...chord,
    key,
    type: 'keyDown',
    isAutoRepeat: false,
    isComposing: false,
    location: 0,
    modifiers: ['meta', 'alt']
  }
  const emit = (overrides: Partial<Electron.Input> = {}) => {
    const event = { preventDefault: vi.fn(), defaultPrevented: false }
    guest.emit('before-input-event', event, { ...input, ...overrides })
    return event.preventDefault
  }
  const send = vi.mocked(renderer.send)
  try {
    if (modifierSequence) {
      expect(
        emit({ key: 'Meta', code: 'MetaLeft', alt: false, modifiers: ['meta'] })
      ).not.toHaveBeenCalled()
      expect(emit({ key: 'Alt', code: 'AltLeft' })).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()
    }
    expect(emit()).toHaveBeenCalledOnce()
    expect(send.mock.calls).toEqual([['ui:quickStartChat']])
    expect(emit({ type: 'keyUp' })).not.toHaveBeenCalled()
    if (modifierSequence) {
      expect(
        emit({ type: 'keyUp', key: 'Alt', code: 'AltLeft', alt: false, modifiers: ['meta'] })
      ).not.toHaveBeenCalled()
      expect(
        emit({
          type: 'keyUp',
          key: 'Meta',
          code: 'MetaLeft',
          meta: false,
          alt: false,
          modifiers: []
        })
      ).not.toHaveBeenCalled()
    }
    expect(send.mock.calls).toEqual([['ui:quickStartChat']])
  } finally {
    cleanup()
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  }
})

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
