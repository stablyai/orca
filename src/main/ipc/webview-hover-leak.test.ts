import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
const sendInputEvent = vi.fn()
const fromWebContents = vi.fn()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel)
    }
  },
  BrowserWindow: {
    fromWebContents: (...args: unknown[]) => fromWebContents(...args)
  }
}))

const {
  CLEAR_STALE_HOVER_CHANNEL,
  registerWebviewHoverLeakHandlers,
  resetWebviewHoverLeakThrottleForTests
} = await import('./webview-hover-leak')

describe('registerWebviewHoverLeakHandlers', () => {
  let now = 1000

  beforeEach(() => {
    now = 1000
    sendInputEvent.mockClear()
    fromWebContents.mockReset()
    resetWebviewHoverLeakThrottleForTests()
    registerWebviewHoverLeakHandlers(() => now)
  })

  afterEach(() => {
    handlers.clear()
  })

  function invoke(senderId = 1): unknown {
    const handler = handlers.get(CLEAR_STALE_HOVER_CHANNEL)
    if (!handler) {
      throw new Error('handler was not registered')
    }
    return handler({ sender: { id: senderId } })
  }

  it('clears hover with a mouseLeave carrying no renderer-supplied coordinates', () => {
    fromWebContents.mockReturnValue({ isDestroyed: () => false, webContents: { sendInputEvent } })

    invoke()

    expect(sendInputEvent).toHaveBeenCalledWith({ type: 'mouseLeave', x: -1, y: -1 })
  })

  it('coalesces bursts from one renderer', () => {
    fromWebContents.mockReturnValue({ isDestroyed: () => false, webContents: { sendInputEvent } })

    invoke()
    invoke()
    now += 10
    invoke()

    expect(sendInputEvent).toHaveBeenCalledTimes(1)

    now += 50
    invoke()

    expect(sendInputEvent).toHaveBeenCalledTimes(2)
  })

  it('throttles per renderer rather than globally', () => {
    fromWebContents.mockReturnValue({ isDestroyed: () => false, webContents: { sendInputEvent } })

    invoke(1)
    invoke(2)

    expect(sendInputEvent).toHaveBeenCalledTimes(2)
  })

  it('ignores a destroyed or detached window', () => {
    fromWebContents.mockReturnValue({ isDestroyed: () => true, webContents: { sendInputEvent } })
    invoke()

    fromWebContents.mockReturnValue(null)
    invoke(2)

    expect(sendInputEvent).not.toHaveBeenCalled()
  })
})
