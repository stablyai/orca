import { describe, expect, it } from 'vitest'
import type { TerminalWebViewCommand } from './terminal-webview-messages'
import { createTerminalWebViewPendingMessages } from './terminal-webview-pending-messages'

function flushMessages(
  queue: ReturnType<typeof createTerminalWebViewPendingMessages>
): TerminalWebViewCommand[] {
  const messages: TerminalWebViewCommand[] = []
  queue.flush((message) => messages.push(message))
  return messages
}

describe('TerminalWebView pending messages', () => {
  it('evicts the oldest writes without dropping or reordering control messages', () => {
    const queue = createTerminalWebViewPendingMessages()
    queue.queue({ type: 'resize', cols: 80, rows: 24 })
    for (let index = 0; index < 5200; index += 1) {
      if (index === 100) {
        queue.queue({ type: 'clear' })
      }
      if (index === 3000) {
        queue.queue({ type: 'set-font-scale', fontScale: 1.1 })
      }
      queue.queue({ type: 'write', data: String(index) })
    }

    const messages = flushMessages(queue)
    const writes = messages.filter((message) => message.type === 'write')
    expect(writes).toHaveLength(4096)
    expect(writes[0]).toEqual({ type: 'write', data: '1104' })
    expect(writes.at(-1)).toEqual({ type: 'write', data: '5199' })
    expect(messages.slice(0, 2).map((message) => message.type)).toEqual(['resize', 'clear'])
    expect(messages.findIndex((message) => message.type === 'set-font-scale')).toBe(
      messages.findIndex((message) => message.type === 'write' && message.data === '3000') - 1
    )
  })

  it('applies the byte cap while keeping control messages', () => {
    const queue = createTerminalWebViewPendingMessages()
    queue.queue({ type: 'write', data: 'a'.repeat(400_000) })
    queue.queue({ type: 'clear' })
    queue.queue({ type: 'write', data: 'b'.repeat(400_000) })
    queue.queue({ type: 'write', data: 'c'.repeat(400_000) })
    queue.queue({ type: 'write', data: 'd'.repeat(700_000) })

    const messages = flushMessages(queue)
    expect(messages.map((message) => message.type)).toEqual(['clear', 'write'])
    expect(messages[1]).toEqual({ type: 'write', data: 'd'.repeat(700_000) })
  })

  it('clears pending messages and accepts a fresh generation', () => {
    const queue = createTerminalWebViewPendingMessages()
    queue.queue({ type: 'write', data: 'stale' })
    queue.clear()
    queue.queue({ type: 'write', data: 'fresh' })

    expect(flushMessages(queue)).toEqual([{ type: 'write', data: 'fresh' }])
  })
})
