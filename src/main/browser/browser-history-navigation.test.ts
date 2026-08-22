import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { waitForBrowserHistoryNavigation } from './browser-history-navigation'

function historyWebContents(options: { canGoBack?: boolean; canGoForward?: boolean }): {
  emitter: EventEmitter
  history: {
    canGoBack: ReturnType<typeof vi.fn>
    canGoForward: ReturnType<typeof vi.fn>
    goBack: ReturnType<typeof vi.fn>
    goForward: ReturnType<typeof vi.fn>
  }
  webContents: Electron.WebContents
} {
  const emitter = new EventEmitter()
  const history = {
    canGoBack: vi.fn(() => options.canGoBack ?? false),
    canGoForward: vi.fn(() => options.canGoForward ?? false),
    goBack: vi.fn(),
    goForward: vi.fn()
  }
  return {
    emitter,
    history,
    webContents: Object.assign(emitter, {
      navigationHistory: history
    }) as unknown as Electron.WebContents
  }
}

describe('browser history navigation', () => {
  it.each([
    ['back', 'did-navigate'],
    ['forward', 'did-navigate-in-page']
  ] as const)('settles direct %s navigation on %s', async (direction, event) => {
    const { emitter, history, webContents } = historyWebContents({
      canGoBack: true,
      canGoForward: true
    })
    history[direction === 'back' ? 'goBack' : 'goForward'].mockImplementation(() => {
      queueMicrotask(() =>
        event === 'did-navigate-in-page'
          ? emitter.emit(event, {}, 'https://example.com', true)
          : emitter.emit(event)
      )
    })

    await expect(waitForBrowserHistoryNavigation(webContents, direction)).resolves.toBe('navigated')

    expect(history[direction === 'back' ? 'goBack' : 'goForward']).toHaveBeenCalledOnce()
    expect(emitter.eventNames()).toEqual([])
  })

  it('returns without attaching listeners when no back entry exists', async () => {
    const { emitter, history, webContents } = historyWebContents({ canGoBack: false })

    await expect(waitForBrowserHistoryNavigation(webContents, 'back')).resolves.toBe('navigated')

    expect(history.goBack).not.toHaveBeenCalled()
    expect(emitter.eventNames()).toEqual([])
  })

  it('cleans up and rejects a synchronous navigation failure', async () => {
    const { emitter, history, webContents } = historyWebContents({ canGoBack: true })
    history.goBack.mockImplementation(() => {
      throw new Error('navigation failed')
    })

    await expect(waitForBrowserHistoryNavigation(webContents, 'back')).rejects.toThrow(
      'navigation failed'
    )
    expect(emitter.eventNames()).toEqual([])
  })

  it('settles and removes listeners when navigation emits no completion event', async () => {
    vi.useFakeTimers()
    try {
      const { emitter, history, webContents } = historyWebContents({ canGoBack: true })
      const pending = waitForBrowserHistoryNavigation(webContents, 'back')

      await vi.advanceTimersByTimeAsync(10_000)

      await expect(pending).resolves.toBe('navigated')
      expect(history.goBack).toHaveBeenCalledOnce()
      expect(emitter.eventNames()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores subframe events until the main frame finishes', async () => {
    const { emitter, history, webContents } = historyWebContents({ canGoBack: true })
    history.goBack.mockImplementation(() => {
      queueMicrotask(() => {
        emitter.emit('did-navigate-in-page', {}, 'https://frame.example', false)
        emitter.emit('did-fail-load', {}, -3, 'aborted', 'https://frame.example', false)
      })
    })
    const pending = waitForBrowserHistoryNavigation(webContents, 'back')
    let settled = false
    void pending.then(() => {
      settled = true
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)

    emitter.emit('did-navigate-in-page', {}, 'https://example.com', true)
    await expect(pending).resolves.toBe('navigated')
    expect(emitter.eventNames()).toEqual([])
  })

  it('reports a destroyed guest as a replacement boundary', async () => {
    const { emitter, history, webContents } = historyWebContents({ canGoForward: true })
    history.goForward.mockImplementation(() => {
      queueMicrotask(() => emitter.emit('destroyed'))
    })

    await expect(waitForBrowserHistoryNavigation(webContents, 'forward')).resolves.toBe('replaced')
    expect(emitter.eventNames()).toEqual([])
  })
})
