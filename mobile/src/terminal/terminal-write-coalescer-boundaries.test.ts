import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalWebViewCommand } from './terminal-webview-messages'
import { createTerminalWebViewPendingMessages } from './terminal-webview-pending-messages'
import {
  createTerminalWriteCoalescer,
  TERMINAL_WRITE_FLUSH_WINDOW_MS
} from './terminal-write-coalescer'

// Simulates TerminalWebView's postMessage: ready → deliver, not ready → queue.
// There is no React render harness in the node environment, so the boundary
// invariants are gated here against the same pending-queue module the component uses.
function createSimulatedTerminalWebView() {
  const delivered: TerminalWebViewCommand[] = []
  const pendingMessages = createTerminalWebViewPendingMessages()
  const readiness = { webReady: true }
  const send = (msg: TerminalWebViewCommand) => {
    delivered.push(msg)
  }
  const postMessage = (msg: TerminalWebViewCommand) => {
    if (!readiness.webReady) {
      pendingMessages.queue(msg)
      return
    }
    send(msg)
  }
  const coalescer = createTerminalWriteCoalescer((data) => postMessage({ type: 'write', data }))
  return { coalescer, delivered, pendingMessages, postMessage, readiness, send }
}

describe('terminal write coalescer boundaries', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('drops buffered pre-snapshot writes on init (write → clear → init supersession)', () => {
    vi.useFakeTimers()
    const view = createSimulatedTerminalWebView()

    view.coalescer.write('a')
    view.coalescer.write('stale-pre-snapshot')
    // init() boundary as wired in TerminalWebView: clear the coalescer, then post init.
    view.coalescer.clear()
    view.postMessage({ type: 'init', cols: 80, rows: 24, initialData: 'snapshot', frame: null })
    vi.runOnlyPendingTimers()

    expect(view.delivered).toEqual([
      { type: 'write', data: 'a' },
      { type: 'init', cols: 80, rows: 24, initialData: 'snapshot', frame: null }
    ])
    const initIndex = view.delivered.findIndex((msg) => msg.type === 'init')
    expect(initIndex).toBeGreaterThanOrEqual(0)
    expect(view.delivered.slice(initIndex + 1)).toEqual([])
  })

  it('keeps foreground recovery safe: a late timer flush lands before init in FIFO order', () => {
    vi.useFakeTimers()
    const view = createSimulatedTerminalWebView()

    view.coalescer.write('live')
    view.coalescer.write('buffered-mid-recovery')
    // prepareForForegroundRecovery(): readiness invalidated before the timer fires.
    view.readiness.webReady = false
    vi.advanceTimersByTime(TERMINAL_WRITE_FLUSH_WINDOW_MS)

    // Recovery re-init: coalescer.clear() cancels any pending timer synchronously,
    // so nothing can flush after this point; the queued init supersedes the flush.
    view.coalescer.clear()
    view.postMessage({ type: 'init', cols: 80, rows: 24, initialData: 'snapshot', frame: null })

    view.readiness.webReady = true
    view.pendingMessages.flush(view.send)
    vi.runOnlyPendingTimers()

    expect(view.delivered).toEqual([
      { type: 'write', data: 'live' },
      { type: 'write', data: 'buffered-mid-recovery' },
      { type: 'init', cols: 80, rows: 24, initialData: 'snapshot', frame: null }
    ])
    // Invariant: no write reaches the document after the recovery init.
    const initIndex = view.delivered.findIndex((msg) => msg.type === 'init')
    expect(view.delivered.slice(initIndex + 1).filter((msg) => msg.type === 'write')).toEqual([])
  })

  it('delivers the deferred-recovery timer flush when no init follows (skipped recovery)', () => {
    vi.useFakeTimers()
    const view = createSimulatedTerminalWebView()

    view.coalescer.write('live')
    view.coalescer.write('still-current-document')
    view.readiness.webReady = false
    vi.advanceTimersByTime(TERMINAL_WRITE_FLUSH_WINDOW_MS)

    // 'skipped' recovery: pong re-confirms readiness, no init is posted — the
    // buffered bytes belong to the still-live document and must not be lost.
    view.readiness.webReady = true
    view.pendingMessages.flush(view.send)

    expect(view.delivered).toEqual([
      { type: 'write', data: 'live' },
      { type: 'write', data: 'still-current-document' }
    ])
  })
})
