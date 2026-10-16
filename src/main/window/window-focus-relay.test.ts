import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { installWindowFocusRelay } from './window-focus-relay'

function createWindow() {
  let destroyed = false
  const window = Object.assign(new EventEmitter(), {
    webContents: { send: vi.fn(), isDestroyed: () => destroyed },
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The relay reads only on, isDestroyed and webContents.send/isDestroyed.
  installWindowFocusRelay(window as never)
  return window
}

it('relays OS focus and blur to the renderer', () => {
  const window = createWindow()
  window.emit('blur')
  window.emit('focus')
  expect(window.webContents.send.mock.calls).toEqual([
    ['window:focus-changed', false],
    ['window:focus-changed', true]
  ])
})

it('stays quiet once the window is destroyed', () => {
  const window = createWindow()
  window.destroy()
  window.emit('blur')
  expect(window.webContents.send).not.toHaveBeenCalled()
})
