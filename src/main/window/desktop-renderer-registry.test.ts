import { afterEach, describe, expect, it, vi } from 'vitest'

const focus = vi.hoisted(() => ({ id: 0 }))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  let serial = 0
  const windows: Window[] = []
  class Contents extends EventEmitter {
    id = ++serial
    private destroyed = false
    isDestroyed = (): boolean => this.destroyed
    getType = (): string => 'window'
    send = vi.fn()
    destroy = (): void => {
      this.destroyed = true
      this.emit('destroyed')
    }
  }
  class Window {
    webContents = new Contents()
    constructor() {
      windows.push(this)
    }
    destroy = (): void => this.webContents.destroy()
    static getFocusedWindow = (): Window | null =>
      windows.find(
        (window) => !window.webContents.isDestroyed() && window.webContents.id === focus.id
      ) ?? null
  }
  return { BrowserWindow: Window }
})

import { BrowserWindow } from 'electron'
import {
  isRegisteredDesktopRenderer,
  isTrustedDesktopRenderer,
  listDesktopRenderers,
  preferredDesktopRenderer,
  registerDesktopRenderer,
  setDesktopRendererFocusResolver,
  unregisterDesktopRenderer
} from './desktop-renderer-registry'
import {
  isTrustedBrowserRenderer,
  setTrustedBrowserRendererWebContentsId
} from '../ipc/browser-renderer-trust'

afterEach(() => {
  for (const renderer of listDesktopRenderers()) {
    unregisterDesktopRenderer(renderer)
  }
  setTrustedBrowserRendererWebContentsId(null)
  setDesktopRendererFocusResolver(null)
  focus.id = 0
})

describe('registered desktop renderers', () => {
  it('keeps multiple native windows trusted and removes only the closed window', () => {
    const firstWindow = new BrowserWindow({ show: false })
    const first = firstWindow.webContents
    const second = new BrowserWindow({ show: false }).webContents
    const third = new BrowserWindow({ show: false }).webContents
    registerDesktopRenderer(first)
    registerDesktopRenderer(second)
    registerDesktopRenderer(third)
    setTrustedBrowserRendererWebContentsId(first.id)

    expect(isTrustedBrowserRenderer(second)).toBe(true)
    firstWindow.destroy()
    Object.defineProperty(first, 'id', {
      get: () => {
        throw new Error('Object has been destroyed')
      }
    })
    expect(() => unregisterDesktopRenderer(first)).not.toThrow()
    expect(isRegisteredDesktopRenderer(first)).toBe(false)
    expect(isTrustedBrowserRenderer(second)).toBe(true)
    expect(isTrustedBrowserRenderer(third)).toBe(true)
    expect(listDesktopRenderers()).toEqual([second, third])
  })

  it('routes a preferred target to the focused desktop, with a surviving fallback', () => {
    const first = new BrowserWindow({ show: false }).webContents
    const second = new BrowserWindow({ show: false }).webContents
    const foreign = new BrowserWindow({ show: false }).webContents
    registerDesktopRenderer(first)
    registerDesktopRenderer(second)

    setDesktopRendererFocusResolver(() => BrowserWindow.getFocusedWindow()?.webContents ?? null)
    focus.id = second.id
    expect(preferredDesktopRenderer()).toBe(second)
    expect(preferredDesktopRenderer(second.id)).toBe(first)
    focus.id = foreign.id
    expect(preferredDesktopRenderer()).toBe(first)
    unregisterDesktopRenderer(first)
    expect(preferredDesktopRenderer()).toBe(second)
  })

  it('uses registered survivors without any desktop focus resolver', () => {
    expect(preferredDesktopRenderer()).toBeNull()
    const firstWindow = new BrowserWindow({ show: false })
    const first = firstWindow.webContents
    const second = new BrowserWindow({ show: false }).webContents
    registerDesktopRenderer(first)
    registerDesktopRenderer(second)
    focus.id = second.id
    expect(preferredDesktopRenderer()).toBe(first)
    expect(preferredDesktopRenderer(first.id)).toBe(second)
    firstWindow.destroy()
    expect(preferredDesktopRenderer()).toBe(second)
    expect(preferredDesktopRenderer(second.id)).toBeNull()
  })

  it('does not trust another object with the same numeric renderer id', () => {
    const registered = new BrowserWindow({ show: false }).webContents
    const foreign = new BrowserWindow({ show: false }).webContents
    registerDesktopRenderer(registered)
    Object.defineProperty(foreign, 'id', { value: registered.id })

    expect(isRegisteredDesktopRenderer(foreign)).toBe(false)
    expect(isTrustedDesktopRenderer(foreign, registered.id, true)).toBe(false)
    unregisterDesktopRenderer(foreign)
    expect(isRegisteredDesktopRenderer(registered)).toBe(true)
    expect(listDesktopRenderers(foreign.id)).toEqual([])
  })
})
