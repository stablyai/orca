import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { QUIT_RENDERER_ACK_TIMEOUT_MS } from '../../shared/quit-teardown-deadline'
import {
  installWorkspaceWindowCloseLifecycle,
  acknowledgeWorkspaceWindowClose
} from './workspace-window-close-lifecycle'

afterEach(() => vi.useRealTimers())

function setup(quitting = false) {
  const webContents = Object.assign(new EventEmitter(), {
    isCrashed: vi.fn(() => false),
    send: vi.fn()
  })
  const window = Object.assign(new EventEmitter(), {
    webContents,
    isDestroyed: () => false,
    destroy: vi.fn()
  })
  installWorkspaceWindowCloseLifecycle(window as never, () => quitting)
  const close = () => {
    const event = { preventDefault: vi.fn() }
    window.emit('close', event)
    return event
  }
  return { window, webContents, close }
}

it('allows a crashed secondary to close without waiting for its renderer', () => {
  const { webContents, close } = setup()
  webContents.isCrashed.mockReturnValue(true)
  expect(close().preventDefault).not.toHaveBeenCalled()
  expect(webContents.send).not.toHaveBeenCalled()
})

it('bypasses a gone renderer but restores confirmation after reload', () => {
  const { webContents, close } = setup()
  webContents.emit('render-process-gone')
  expect(close().preventDefault).not.toHaveBeenCalled()
  webContents.emit('did-finish-load')
  expect(close().preventDefault).toHaveBeenCalled()
})

it('bounds quit acknowledgement without timing out an acknowledged save decision', () => {
  vi.useFakeTimers()
  const first = setup(true)
  first.close()
  vi.advanceTimersByTime(QUIT_RENDERER_ACK_TIMEOUT_MS)
  expect(first.window.destroy).toHaveBeenCalledOnce()
  const second = setup(true)
  second.close()
  const request = second.webContents.send.mock.calls[0]![1] as { requestId: number }
  acknowledgeWorkspaceWindowClose(second.window as never, request.requestId)
  vi.advanceTimersByTime(QUIT_RENDERER_ACK_TIMEOUT_MS)
  expect(second.window.destroy).not.toHaveBeenCalled()
})

it('does not time out ordinary close confirmation', () => {
  vi.useFakeTimers()
  const { window, close } = setup()
  expect(close().preventDefault).toHaveBeenCalled()
  vi.advanceTimersByTime(QUIT_RENDERER_ACK_TIMEOUT_MS * 2)
  expect(window.destroy).not.toHaveBeenCalled()
})
