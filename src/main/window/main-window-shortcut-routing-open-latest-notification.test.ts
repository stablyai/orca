import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: true } }))

import type { BrowserWindow } from 'electron'
import { installMainWindowShortcutRouting } from './main-window-shortcut-routing'
import type { MainWindowFocusLifecycle } from './main-window-focus-lifecycle'
import { openLatestNotification, registerOpenableNotification } from '../ipc/openable-notifications'

const originalPlatform = process.platform
const cmdOptionEnter = {
  type: 'keyDown',
  code: 'Enter',
  key: 'Enter',
  meta: true,
  control: false,
  alt: true,
  shift: false
}

function installRouting(terminalFocused: boolean): (input: object) => ReturnType<typeof vi.fn> {
  const handlers: Record<string, (...args: unknown[]) => void> = {}
  const mainWindow = {
    on: vi.fn(),
    webContents: {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers[event] = handler
      }),
      send: vi.fn()
    }
  }
  const focus: MainWindowFocusLifecycle = {
    dispose: vi.fn(),
    isFloatingPanelFocused: () => false,
    isFloatingTerminalInputFocused: () => false,
    isMarkdownEditorFocused: () => false,
    isRendererProcessGone: () => false,
    isShortcutRecorderFocused: () => false,
    isTerminalInputFocused: () => terminalFocused,
    notifySystemResume: vi.fn()
  }
  installMainWindowShortcutRouting({
    focus,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: routing reads only on() and webContents.on/send, which this stub provides.
    mainWindow: mainWindow as unknown as BrowserWindow,
    store: null
  })
  return (input) => {
    const preventDefault = vi.fn()
    handlers['before-input-event']({ preventDefault }, input)
    return preventDefault
  }
}

beforeEach(() => Object.defineProperty(process, 'platform', { value: 'darwin' }))
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  while (openLatestNotification()) {
    // drain the module-level list between tests
  }
})

describe('open latest notification routing', () => {
  it('leaves Cmd+Option+Enter to the focused terminal when nothing is open-able', () => {
    const press = installRouting(true)

    expect(press(cmdOptionEnter)).not.toHaveBeenCalled()
  })

  it('claims the chord and opens the newest notification', () => {
    const open = vi.fn()
    registerOpenableNotification(open)
    const press = installRouting(true)

    expect(press(cmdOptionEnter)).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('opens only once while the chord auto-repeats', () => {
    const older = vi.fn()
    const newer = vi.fn()
    registerOpenableNotification(older)
    registerOpenableNotification(newer)
    const press = installRouting(false)

    press(cmdOptionEnter)
    expect(press({ ...cmdOptionEnter, isAutoRepeat: true })).toHaveBeenCalledTimes(1)

    expect(newer).toHaveBeenCalledTimes(1)
    expect(older).not.toHaveBeenCalled()
  })
})
