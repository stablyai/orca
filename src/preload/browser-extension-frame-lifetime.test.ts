import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { installBrowserExtensionFrameLifetime } from './browser-extension-frame-lifetime'
import { PRELOAD_BROWSER_EXTENSION_FRAME_LIFETIME_CHANNEL } from './browser-extension-api-surface'

describe('extension frame lifetime receiver', () => {
  it('retains the current endpoint and closes replaced and surplus endpoints', () => {
    const ipcRenderer = Object.assign(new EventEmitter(), {
      invoke: vi.fn(),
      postMessage: vi.fn(),
      send: vi.fn(),
      sendSync: vi.fn(),
      sendToHost: vi.fn()
    })
    installBrowserExtensionFrameLifetime(ipcRenderer)
    const first = { close: vi.fn() }
    const second = { close: vi.fn() }
    const surplus = { close: vi.fn() }
    ipcRenderer.emit(PRELOAD_BROWSER_EXTENSION_FRAME_LIFETIME_CHANNEL, { ports: [first] })
    ipcRenderer.emit(PRELOAD_BROWSER_EXTENSION_FRAME_LIFETIME_CHANNEL, { ports: [] })
    expect(first.close).not.toHaveBeenCalled()
    ipcRenderer.emit(PRELOAD_BROWSER_EXTENSION_FRAME_LIFETIME_CHANNEL, {
      ports: [second, surplus]
    })
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).not.toHaveBeenCalled()
    expect(surplus.close).toHaveBeenCalledTimes(1)
    ipcRenderer.emit(PRELOAD_BROWSER_EXTENSION_FRAME_LIFETIME_CHANNEL, { ports: [] })
    expect(second.close).not.toHaveBeenCalled()
  })
})
