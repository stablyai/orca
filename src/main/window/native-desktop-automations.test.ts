import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRendererChannel } from '../automations/service'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  let serial = 0
  class Contents extends EventEmitter {
    id = ++serial
    private destroyed = false
    isDestroyed = () => this.destroyed
    isLoadingMainFrame = () => true
    getType = () => 'window'
    send = vi.fn()
    destroy(): void {
      this.destroyed = true
      this.emit('destroyed')
    }
  }
  class Window {
    webContents = new Contents()
    destroy = () => this.webContents.destroy()
    static getFocusedWindow = () => null
  }
  return { BrowserWindow: Window }
})

import { BrowserWindow } from 'electron'
import {
  listDesktopRenderers,
  registerDesktopRenderer,
  unregisterDesktopRenderer
} from './desktop-renderer-registry'
import {
  attachNativeDesktopAutomations,
  markNativeDesktopAutomationReady
} from './native-desktop-automations'

afterEach(() => {
  for (const renderer of listDesktopRenderers()) {
    unregisterDesktopRenderer(renderer)
  }
})

describe('native desktop automation channel', () => {
  it('keeps its ready peer dispatching while another attaches, reloads or closes', () => {
    const service = { setWebContents: vi.fn<(channel: AutomationRendererChannel | null) => void>() }
    const first = new BrowserWindow({ show: false })
    const second = new BrowserWindow({ show: false })
    registerDesktopRenderer(first.webContents, 'first')
    attachNativeDesktopAutomations(service, first)
    const channel = service.setWebContents.mock.calls[0]?.[0]
    if (!channel) {
      throw new Error('Missing automation channel')
    }
    expect(channel.isDestroyed()).toBe(true)
    markNativeDesktopAutomationReady(service, first.webContents)
    registerDesktopRenderer(second.webContents, 'second')
    attachNativeDesktopAutomations(service, second)
    expect(service.setWebContents).toHaveBeenCalledTimes(1)
    channel.send('dispatch', 'first')
    expect(first.webContents.send).toHaveBeenCalledWith('dispatch', 'first')
    markNativeDesktopAutomationReady(service, second.webContents)
    first.webContents.emit('did-start-loading')
    channel.send('dispatch', 'second')
    expect(second.webContents.send).toHaveBeenCalledWith('dispatch', 'second')
    first.destroy()
    expect(channel.isDestroyed()).toBe(false)
    second.destroy()
    expect(channel.isDestroyed()).toBe(true)
    expect(() => channel.send('dispatch')).toThrow('runtime_unavailable')
  })
})
