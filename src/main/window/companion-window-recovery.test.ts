import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import { getDefaultUIState } from '../../shared/constants'

const { windows, FakeWindow } = vi.hoisted(() => {
  const windows: FakeWindow[] = []
  class FakeWindow {
    destroyed = false
    crashed = false
    private readonly closedListeners: (() => void)[] = []
    webContents = {
      isDestroyed: () => this.destroyed,
      isCrashed: () => this.crashed,
      reload: vi.fn(() => {
        this.crashed = false
      }),
      on: vi.fn(),
      session: {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn()
      }
    }
    constructor() {
      windows.push(this)
    }
    on(event: string, listener: () => void): void {
      if (event === 'closed') {
        this.closedListeners.push(listener)
      }
    }
    once = vi.fn()
    loadFile = vi.fn()
    isDestroyed = (): boolean => this.destroyed
    isMinimized = (): boolean => false
    close(): void {
      this.destroyed = true
      for (const listener of this.closedListeners) {
        listener()
      }
    }
  }
  return { windows, FakeWindow }
})

vi.mock('electron', () => ({
  app: Object.assign(new EventEmitter(), { isPackaged: true }),
  BrowserWindow: FakeWindow,
  nativeTheme: { shouldUseDarkColors: true }
}))
vi.mock('../ipc/ui', () => ({ sendToTrustedUIRenderer: vi.fn() }))
vi.mock('./privileged-window-navigation', () => ({
  installPrivilegedWindowNavigationPolicy: vi.fn()
}))

import { createOrFocusDashboardPopout, closeDashboardPopout } from './dashboard-popout-window'
import {
  createOrFocusWorkspaceSpaceWindow,
  closeWorkspaceSpaceWindow
} from './workspace-space-window'

const storeMethods: Pick<Store, 'getUI' | 'onUIChanged'> = {
  getUI: getDefaultUIState,
  onUIChanged: () => () => {}
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Companion creation only calls these two Store methods; no bounds events are emitted.
const store = storeMethods as Store

afterEach(() => {
  closeDashboardPopout()
  closeWorkspaceSpaceWindow()
  windows.length = 0
  vi.unstubAllEnvs()
})

describe.each([
  { name: 'dashboard popout', open: () => createOrFocusDashboardPopout(null) },
  { name: 'workspace space', open: () => createOrFocusWorkspaceSpaceWindow(store) }
])('$name renderer recovery', ({ open }) => {
  it('preserves a healthy document and reloads a crashed renderer on manual reopen', () => {
    vi.stubEnv('ORCA_BACKGROUND_LAUNCH', '1')
    const first = open()
    const window = windows[0]

    expect(open()).toBe(first)
    expect(window.webContents.reload).not.toHaveBeenCalled()

    window.crashed = true
    expect(window.webContents.reload).not.toHaveBeenCalled()
    expect(open()).toBe(first)
    expect(window.webContents.reload).toHaveBeenCalledTimes(1)
    expect(windows).toHaveLength(1)

    open()
    expect(window.webContents.reload).toHaveBeenCalledTimes(1)
    window.crashed = true
    expect(open()).toBe(first)
    expect(window.webContents.reload).toHaveBeenCalledTimes(2)
    expect(windows).toHaveLength(1)
  })
})
