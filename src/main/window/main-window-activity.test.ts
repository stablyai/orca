import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, () => unknown>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: () => unknown) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel)
  }
}))

import { installMainWindowActivityRelay, type ActivityWindow } from './main-window-activity'

function fakeWindow() {
  const state = { focused: true, visible: true, minimized: false }
  const sent: boolean[] = []
  const emitter = new EventEmitter()
  const window: ActivityWindow = {
    isDestroyed: () => false,
    isFocused: () => state.focused,
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    on: (event, listener) => emitter.on(event, listener),
    webContents: { isDestroyed: () => false, send: (_channel, active) => sent.push(active) }
  }
  return { window, emitter, state, sent }
}

describe('installMainWindowActivityRelay', () => {
  it('reports the window inactive when it blurs, minimizes or hides, once per change', () => {
    const { window, emitter, state, sent } = fakeWindow()
    const relay = installMainWindowActivityRelay(window)
    expect(handlers.get('window:isActive')?.()).toBe(true)
    emitter.emit('focus')
    state.minimized = true
    emitter.emit('minimize')
    emitter.emit('blur')
    state.minimized = false
    emitter.emit('restore')
    state.visible = false
    emitter.emit('hide')
    expect(sent).toEqual([true, false, true, false])
    relay.dispose()
    expect(handlers.has('window:isActive')).toBe(false)
  })
})
