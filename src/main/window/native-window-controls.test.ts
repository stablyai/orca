import { afterEach, describe, expect, it, vi } from 'vitest'

const { handlers, menuParents } = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: unknown }) => unknown>(),
  menuParents: new Set<unknown>()
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  let serial = 0
  class Window extends EventEmitter {
    webContents = { id: ++serial }
    private closed = false
    private maximized = false
    private minimized = false
    isDestroyed = (): boolean => this.closed
    isMaximized = (): boolean => this.maximized
    isMinimized = (): boolean => this.minimized
    close = (): void => {
      this.closed = true
    }
    minimize = (): void => {
      this.minimized = true
    }
    maximize = (): void => {
      this.maximized = true
    }
    unmaximize = (): void => {
      this.maximized = false
    }
  }
  return {
    BrowserWindow: Window,
    ipcMain: Object.assign(new EventEmitter(), {
      handle: (channel: string, handler: (event: { sender: unknown }) => unknown) =>
        handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel)
    }),
    Menu: {
      getApplicationMenu: () => ({
        popup: ({ window }: { window: unknown }) => menuParents.add(window)
      })
    }
  }
})

import { BrowserWindow, ipcMain } from 'electron'
import { installNativeWindowControls } from './native-window-controls'

const disposers: (() => void)[] = []

function createWindow() {
  const window = new BrowserWindow({ show: false })
  let zoomFactor = 1
  disposers.push(
    installNativeWindowControls({
      window,
      requestClose: () => window.close(),
      confirmClose: () => window.close(),
      syncTrafficLights: (factor) => {
        zoomFactor = factor
      }
    })
  )
  return { window, event: { sender: window.webContents }, zoom: () => zoomFactor }
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose()
  }
  menuParents.clear()
})

describe('native desktop window controls', () => {
  it('keeps controls and close confirmation on the requesting window', () => {
    const first = createWindow()
    const second = createWindow()
    const third = createWindow()

    ipcMain.emit('window:minimize', second.event)
    ipcMain.emit('window:maximize', third.event)
    ipcMain.emit('ui:sync-traffic-lights', second.event, 1.5)
    ipcMain.emit('menu:popup', third.event)
    ipcMain.emit('window:confirm-close', first.event)

    expect(first.window.isDestroyed()).toBe(true)
    expect(second.window.isDestroyed()).toBe(false)
    expect(third.window.isDestroyed()).toBe(false)
    expect(second.window.isMinimized()).toBe(true)
    expect(third.window.isMinimized()).toBe(false)
    expect(third.window.isMaximized()).toBe(true)
    expect(second.window.isMaximized()).toBe(false)
    expect(second.zoom()).toBe(1.5)
    expect(third.zoom()).toBe(1)
    expect(menuParents).toEqual(new Set([third.window]))
  })

  it('keeps the surviving window query and controls after another window is disposed', () => {
    const first = createWindow()
    const second = createWindow()
    disposers.shift()?.()
    ipcMain.emit('window:maximize', second.event)

    expect(handlers.get('window:isMaximized')?.(second.event)).toBe(true)
    expect(handlers.get('window:isMaximized')?.(first.event)).toBe(false)
    ipcMain.emit('window:request-close', second.event)
    expect(second.window.isDestroyed()).toBe(true)
    expect(first.window.isDestroyed()).toBe(false)
  })

  it('rejects a renderer that does not own a registered window', () => {
    const first = createWindow()
    const foreignEvent = { sender: { id: first.window.webContents.id } }
    for (const channel of [
      'window:minimize',
      'window:maximize',
      'window:request-close',
      'window:confirm-close',
      'menu:popup'
    ]) {
      ipcMain.emit(channel, foreignEvent)
    }
    ipcMain.emit('ui:sync-traffic-lights', first.event, Number.NaN)

    expect(first.window.isDestroyed()).toBe(false)
    expect(first.window.isMinimized()).toBe(false)
    expect(first.window.isMaximized()).toBe(false)
    expect(first.zoom()).toBe(1)
    expect(menuParents.size).toBe(0)
    expect(handlers.get('window:isMaximized')?.(foreignEvent)).toBe(false)
  })
})
