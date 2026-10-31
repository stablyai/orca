import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)
  }
}))
vi.mock('../window/dashboard-popout-window', () => ({ isDashboardPopoutRenderer: () => true }))
vi.mock('./ui', () => ({ isTrustedUIRenderer: () => false }))

import { registerTerminalPreviewHandlers } from './terminal-preview'

type Snapshot = { data: string; cols: number; rows: number; seq: number }

function setup() {
  const data = new Set<(value: string) => void>()
  const resize = new Set<(size: { cols: number; rows: number }) => void>()
  const fits = new Set<string>()
  let rawViews = 0
  const runtime = {
    serializeTerminalBuffer: vi.fn(async (): Promise<Snapshot | null> => ({
      data: 'screen',
      cols: 80,
      rows: 24,
      seq: 0
    })),
    subscribeToTerminalData: vi.fn((_ptyId: string, listener: (value: string) => void) => {
      data.add(listener)
      return () => data.delete(listener)
    }),
    subscribeToTerminalResize: vi.fn(
      (_ptyId: string, listener: (size: { cols: number; rows: number }) => void) => {
        resize.add(listener)
        return () => resize.delete(listener)
      }
    ),
    registerRawTerminalViewSubscriber: vi.fn(() => {
      rawViews += 1
      return () => (rawViews -= 1)
    }),
    writeTerminalPreviewInput: vi.fn(async () => true),
    updateRemoteDesktopViewer: vi.fn(async (ptyId: string) => {
      fits.add(ptyId)
      return true
    }),
    unregisterRemoteDesktopViewer: vi.fn(async (ptyId: string) => {
      fits.delete(ptyId)
      return true
    }),
    getTerminalSize: vi.fn(() => ({ cols: 80, rows: 24 }))
  }
  const sender = Object.assign(new EventEmitter(), {
    id: 17,
    isDestroyed: () => false,
    send: vi.fn()
  })
  // SAFETY: The handler only uses the runtime methods implemented by this production-boundary fixture.
  registerTerminalPreviewHandlers(runtime as never)
  const call = (channel: string, args: unknown) => handlers.get(channel)!({ sender }, args)
  return {
    sender,
    runtime,
    data,
    call,
    counts: () => ({ data: data.size, resize: resize.size, raw: rawViews, fits: fits.size })
  }
}

describe('terminal preview document lifetime', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it.each(['did-navigate', 'render-process-gone', 'destroyed'])(
    'releases all preview owners and queued output on %s',
    async (event) => {
      const { sender, data, call, counts } = setup()
      await call('terminalPreview:connect', { ptyId: 'pane' })
      await call('terminalPreview:fit', { ptyId: 'pane', cols: 80, rows: 24 })
      const staleListeners = [...data]
      staleListeners.forEach((listener) => listener('queued'))
      expect(counts()).toEqual({ data: 1, resize: 1, raw: 1, fits: 1 })

      sender.emit(event)
      expect(counts()).toEqual({ data: 0, resize: 0, raw: 0, fits: 0 })
      staleListeners.forEach((listener) => listener('late output'))
      await vi.runAllTimersAsync()
      expect(sender.send).not.toHaveBeenCalled()
    }
  )

  it('rejects a retired snapshot without disposing its replacement preview', async () => {
    const { sender, runtime, call, counts } = setup()
    const snapshot = Promise.withResolvers<Snapshot | null>()
    runtime.serializeTerminalBuffer.mockImplementationOnce(() => snapshot.promise)
    const retired = call('terminalPreview:connect', { ptyId: 'pane' })
    sender.emit('render-process-gone')
    await call('terminalPreview:connect', { ptyId: 'pane-b' })

    snapshot.resolve({ data: 'old screen', cols: 80, rows: 24, seq: 0 })
    await expect(retired).resolves.toEqual({ snapshot: null, replay: [] })
    expect(counts()).toEqual({ data: 1, resize: 1, raw: 1, fits: 0 })
    sender.emit('destroyed')
    expect(counts()).toEqual({ data: 0, resize: 0, raw: 0, fits: 0 })
  })

  it('does not let an old fit completion release the replacement document claim', async () => {
    const { sender, runtime, call, counts } = setup()
    const pendingFit = Promise.withResolvers<boolean>()
    runtime.updateRemoteDesktopViewer.mockImplementationOnce(() => pendingFit.promise)
    const retired = call('terminalPreview:fit', { ptyId: 'pane', cols: 90, rows: 30 })
    sender.emit('did-navigate')
    await call('terminalPreview:fit', { ptyId: 'pane', cols: 80, rows: 24 })
    pendingFit.resolve(false)
    await expect(retired).resolves.toBeNull()
    expect(runtime.unregisterRemoteDesktopViewer).toHaveBeenCalledTimes(1)
    expect(counts()).toEqual({ data: 0, resize: 0, raw: 0, fits: 1 })
    sender.emit('destroyed')
  })

  it('preserves same-document navigation and bounds listeners across ten replacements', async () => {
    const { sender, data, call, counts } = setup()
    for (let index = 0; index < 10; index += 1) {
      await call('terminalPreview:connect', { ptyId: `pane-${index}` })
      await call('terminalPreview:fit', { ptyId: `pane-${index}`, cols: 80, rows: 24 })
      sender.emit('did-navigate-in-page', {}, '#section', true)
      expect(counts()).toEqual({ data: 1, resize: 1, raw: 1, fits: 1 })
      data.forEach((listener) => listener('live output'))
      await vi.advanceTimersByTimeAsync(5)
      expect(sender.send).toHaveBeenCalledTimes(index + 1)
      sender.emit(index % 2 === 0 ? 'did-navigate' : 'render-process-gone')
      expect(counts()).toEqual({ data: 0, resize: 0, raw: 0, fits: 0 })
      expect(sender.listenerCount('did-navigate')).toBe(0)
      expect(sender.listenerCount('render-process-gone')).toBe(0)
      expect(sender.listenerCount('destroyed')).toBe(0)
    }
  })
})
