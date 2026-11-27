import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { ProviderReceiptReaders } from '../../native-chat/agent-session-wire/publication/receipts/provider-receipt-readers'
import { setProcessExitWatchNativeForTests } from '../../pty/process-retirement/native-process-exit-watch'
import { DesktopProviderReceiptWindow } from './desktop-provider-receipt-window'

it.each([true, false])(
  'requires native proof after a persistent re-arm failure (exit: %s)',
  async (exits) => {
    vi.useFakeTimers()
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const signals: ((exited?: boolean) => void)[] = []
    let attempts = 0
    setProcessExitWatchNativeForTests({
      watchProcessExit: () => null,
      watchProcessExitWithProof: (_pid, notice) => {
        attempts++
        if (attempts > 2) {
          return null
        }
        signals.push(notice)
        return attempts
      },
      unwatchProcessExit: () => undefined
    })
    const sender = new EventEmitter()
    const readers = new ProviderReceiptReaders(() => 'test')
    const window = new DesktopProviderReceiptWindow(sender, readers, () => {})
    const transport = window.transport
    let released = 0
    transport.signal.addEventListener('abort', () => released++)
    try {
      const endpoint = { transport: transport.signal, document: new AbortController().signal }
      await readers.read(
        endpoint,
        { reader: { id: randomUUID(), generation: 1 }, since: null, hostIncarnation: null },
        undefined,
        'closed'
      )
      expect(window.watchRenderer(process.pid)).toBe(true)
      expect(readers.handoff(endpoint)).toBe(true)
      sender.emit('destroyed')

      signals[0]!(false)
      expect(readers.hasPostedReply(transport.signal)).toBe(true)
      expect(released).toBe(0)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(attempts).toBe(3)
      expect(timers).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      signals[0]!(true)
      expect(readers.hasPostedReply(transport.signal)).toBe(true)
      signals[1]!(exits)
      signals[1]!(true)
      expect(released).toBe(exits ? 1 : 0)
      expect(readers.hasPostedReply(transport.signal)).toBe(!exits)
      expect(timers).not.toHaveBeenCalled()
      expect(window.transport === transport).toBe(!exits)
    } finally {
      transport.abort()
      window.dispose()
      setProcessExitWatchNativeForTests(undefined)
      timers.mockRestore()
      vi.useRealTimers()
    }
  }
)
