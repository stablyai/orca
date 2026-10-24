import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import { getDefaultUIState } from '../../shared/constants'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    private destroyed = false
    isDestroyed = () => this.destroyed
    close(): void {
      this.destroyed = true
      this.emit('closed')
    }
  }
  return { app: { quit: vi.fn() }, BrowserWindow: Window }
})
vi.mock('./desktop-renderer-registry', () => ({ preferredDesktopRenderer: () => null }))

import { app, BrowserWindow } from 'electron'
import { NativeDesktopWindows, type NativeDesktopWindowOpenOptions } from './native-desktop-windows'

function fixture(initial: Partial<PersistedUIState> = {}) {
  let ui = { ...getDefaultUIState(), ...initial }
  let quitting = false
  let serve = false
  const opened: NativeDesktopWindowOpenOptions[] = []
  const store = {
    getUI: () => ui,
    updateUI: (patch: Partial<PersistedUIState>) => {
      ui = { ...ui, ...patch }
    }
  }
  const manager = new NativeDesktopWindows({
    getStore: () => store,
    isQuitting: () => quitting,
    isServeMode: () => serve,
    openWindow: (options = {}) => {
      const window = new BrowserWindow({ show: false })
      opened.push(options)
      manager.register(window, options.windowId ?? manager.startupId())
      return window
    }
  })
  return {
    manager,
    opened,
    store,
    setQuitting: () => {
      quitting = true
    },
    setServe: () => {
      serve = true
    }
  }
}

beforeEach(() => vi.clearAllMocks())

describe('native desktop windows', () => {
  it('opens more than two peers and closes any window without closing its peers', () => {
    const { manager, store } = fixture()
    for (let i = 0; i < 4; i += 1) {
      expect(manager.open().ok).toBe(true)
    }
    const [first, second, third, fourth] = manager.list()
    if (!first || !second || !third || !fourth) {
      throw new Error('Missing peer windows')
    }
    first.close()
    third.close()
    expect(manager.list()).toEqual([second, fourth])
    expect(store.getUI().desktopWindows?.['desktop-0']?.open).toBe(false)
    expect(app.quit).not.toHaveBeenCalled()
    expect(manager.open({ worktreeId: 'folder::/project' }).ok).toBe(true)
    second.close()
    fourth.close()
    manager.list()[0]?.close()
    expect(app.quit).toHaveBeenCalledTimes(process.platform === 'darwin' ? 0 : 1)
  })

  it('restores only windows open at quit, with their stable ids', () => {
    const { manager, store, setQuitting } = fixture()
    manager.open()
    manager.open()
    manager.open()
    const [first, second, third] = manager.list()
    first?.close()
    setQuitting()
    second?.close()
    third?.close()
    const restored = fixture({ desktopWindows: store.getUI().desktopWindows })
    expect(restored.manager.startupId()).toBe('desktop-1')
    restored.manager.restore()
    expect(restored.opened.map((options) => options.windowId)).toEqual(['desktop-1', 'desktop-2'])
  })

  it('migrates old extra-window records once and does not create windows in serve mode', () => {
    const { manager, store, opened, setServe } = fixture({
      runtimeClientWindows: [
        { slot: 1, open: true, bounds: { x: 20, y: 30, width: 1000, height: 800 } },
        { slot: 2, open: false }
      ]
    })
    expect(manager.startupId()).toBe('desktop-0')
    expect(store.getUI().desktopWindows?.['desktop-1']).toMatchObject({
      open: true,
      bounds: { width: 1000 }
    })
    setServe()
    manager.restore()
    expect(opened).toEqual([])
  })
})
