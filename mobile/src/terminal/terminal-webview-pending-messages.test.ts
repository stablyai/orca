import { describe, expect, it } from 'vitest'
import type { TerminalWebViewCommand } from './terminal-webview-messages'
import {
  createTerminalWebViewPendingMessages,
  MAX_PENDING_WEB_MESSAGES
} from './terminal-webview-pending-messages'

function flushPending(queue: ReturnType<typeof createTerminalWebViewPendingMessages>) {
  const delivered: TerminalWebViewCommand[] = []
  queue.flush((message) => delivered.push(message))
  return delivered
}

describe('terminal WebView pending messages', () => {
  it('retains only the latest snapshot when init is superseded before readiness', () => {
    const queue = createTerminalWebViewPendingMessages()
    queue.queue({ type: 'write', data: 'current-document-tail' })
    queue.queue({ type: 'init', cols: 80, rows: 24, initialData: 'old snapshot' })
    queue.queue({ type: 'write', data: 'covered by the replacement snapshot' })
    queue.queue({ type: 'init', cols: 100, rows: 30, initialData: 'new snapshot' })

    expect(flushPending(queue)).toEqual([
      { type: 'write', data: 'current-document-tail' },
      { type: 'init', cols: 100, rows: 30, initialData: 'new snapshot' }
    ])
  })

  it('caps tiny control-message floods while preserving the newest state', () => {
    const queue = createTerminalWebViewPendingMessages()
    for (let index = 0; index < MAX_PENDING_WEB_MESSAGES + 100; index += 1) {
      queue.queue({ type: 'resize', cols: index + 1, rows: 24 })
    }

    const delivered = flushPending(queue)
    expect(delivered).toHaveLength(MAX_PENDING_WEB_MESSAGES)
    expect(delivered.at(-1)).toEqual({
      type: 'resize',
      cols: MAX_PENDING_WEB_MESSAGES + 100,
      rows: 24
    })
  })
})
