import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { BrowserWindowMock, instances, sendToTrustedUIRendererMock } = vi.hoisted(() => {
  const created: FakeWindow[] = []

  class FakeWindow {
    destroyed = false
    minimized = false
    handlers = new Map<string, () => void>()
    focus = vi.fn()
    restore = vi.fn(() => {
      this.minimized = false
    })
    loadFile = vi.fn()
    show = vi.fn()
    private webContentsHandlers = new Map<string, () => void>()
    close = vi.fn(() => {
      this.destroyed = true
      queueMicrotask(() => this.emit('closed'))
    })
    webContents = {
      id: created.length + 1,
      isDestroyed: () => this.destroyed,
      send: vi.fn(),
      on: (event: string, callback: () => void) => {
        this.webContentsHandlers.set(event, callback)
        return this.webContents
      },
      emit: (event: string) => {
        this.webContentsHandlers.get(event)?.()
      },
      session: {
        setPermissionCheckHandler: vi.fn(),
        setPermissionRequestHandler: vi.fn()
      }
    }

    constructor(readonly options: Electron.BrowserWindowConstructorOptions) {
      created.push(this)
    }

    isDestroyed(): boolean {
      return this.destroyed
    }

    isMinimized(): boolean {
      return this.minimized
    }

    on(event: string, callback: () => void): this {
      this.handlers.set(event, callback)
      return this
    }

    once(event: string, callback: () => void): this {
      return this.on(event, callback)
    }

    emit(event: string): void {
      this.handlers.get(event)?.()
    }
  }

  return {
    BrowserWindowMock: FakeWindow,
    instances: created,
    sendToTrustedUIRendererMock: vi.fn()
  }
})

vi.mock('electron', () => ({
  BrowserWindow: BrowserWindowMock,
  app: { isPackaged: true },
  nativeTheme: { shouldUseDarkColors: false }
}))
vi.mock('../ipc/ui', () => ({ sendToTrustedUIRenderer: sendToTrustedUIRendererMock }))
vi.mock('./foreground-activation-policy', () => ({
  isBackgroundLaunch: () => false,
  showWindowWithoutStealingFocus: (window: FakeWindow) => window.show()
}))
vi.mock('./privileged-window-navigation', () => ({
  installPrivilegedWindowNavigationPolicy: vi.fn()
}))

import {
  closeAllDetachedTerminalWindows,
  closeDetachedTerminalWindow,
  createOrFocusDetachedTerminalWindow,
  getDetachedTerminalInput,
  isDetachedTerminalRenderer,
  isDetachedTerminalRendererForPty,
  updateDetachedTerminalInput
} from './detached-terminal-window'

type FakeWindow = InstanceType<typeof BrowserWindowMock>

function open(tabId = 'tab-1'): ReturnType<typeof createOrFocusDetachedTerminalWindow> {
  return createOrFocusDetachedTerminalWindow({ tabId, ptyId: `pty-${tabId}`, title: tabId })
}

describe('detached terminal windows', () => {
  beforeEach(() => {
    instances.length = 0
    vi.clearAllMocks()
  })

  afterEach(closeAllDetachedTerminalWindows)

  it('opens one companion window per tab and focuses a duplicate request', () => {
    const first = open()
    open()
    open('tab-2')

    expect(first.focus).toHaveBeenCalledTimes(1)
    expect(instances).toHaveLength(2)
  })

  it('notifies the main renderer when the companion closes without owning PTY teardown', async () => {
    const window = open()

    closeDetachedTerminalWindow('tab-1')
    await Promise.resolve()

    expect(window.close).toHaveBeenCalledTimes(1)
    expect(sendToTrustedUIRendererMock).toHaveBeenCalledWith('detachedTerminal:closed', {
      tabId: 'tab-1'
    })
  })

  it('closes the companion and notifies when its renderer process crashes', async () => {
    const window = open('tab-crash')

    window.webContents.emit('render-process-gone')
    await Promise.resolve()

    expect(window.close).toHaveBeenCalledTimes(1)
    expect(sendToTrustedUIRendererMock).toHaveBeenCalledWith('detachedTerminal:closed', {
      tabId: 'tab-crash'
    })
  })

  it('tracks the PTY id and identifies companion renderers by PTY', () => {
    const window = open('tab-1')

    expect(isDetachedTerminalRenderer(window.webContents)).toBe(true)
    expect(isDetachedTerminalRendererForPty(window.webContents, 'pty-tab-1')).toBe(true)
    expect(isDetachedTerminalRendererForPty(window.webContents, 'pty-other')).toBe(false)
  })

  it('keeps the latest pane input facts and pushes them to the companion', () => {
    const window = open('tab-1')
    const conptyInput = {
      hostPlatform: 'win32' as const,
      localWindowsConpty: true,
      windowsShiftEnterEncoding: 'alt-enter' as const,
      ctrlEnterCsiU: false,
      kittyKeyboardAdvertised: false
    }

    // Undefined tells the companion the main renderer has not sent the facts yet.
    expect(getDetachedTerminalInput('tab-1')).toBeUndefined()
    updateDetachedTerminalInput('tab-1', conptyInput)
    updateDetachedTerminalInput('tab-missing', null)

    expect(getDetachedTerminalInput('tab-1')).toBe(conptyInput)
    expect(window.webContents.send).toHaveBeenCalledTimes(1)
    expect(window.webContents.send).toHaveBeenCalledWith(
      'detachedTerminal:terminalInput',
      conptyInput
    )
  })

  it('closes every companion when the main window closes', () => {
    open()
    open('tab-2')

    closeAllDetachedTerminalWindows()

    expect(instances[0].close).toHaveBeenCalledTimes(1)
    expect(instances[1].close).toHaveBeenCalledTimes(1)
  })
})
