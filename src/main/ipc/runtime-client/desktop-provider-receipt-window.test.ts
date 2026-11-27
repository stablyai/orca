import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { expect, it, vi } from 'vitest'
import { ProviderReceiptReaders } from '../../native-chat/agent-session-wire/publication/receipts/provider-receipt-readers'
import { setProcessExitWatchNativeForTests } from '../../pty/process-retirement/native-process-exit-watch'
import { DesktopProviderReceiptWindow } from './desktop-provider-receipt-window'

it('holds closed-window credit across a failed watch and releases it on later exit proof', async () => {
  vi.useFakeTimers()
  const signals: ((exited?: boolean) => void)[] = []
  let attempts = 0
  setProcessExitWatchNativeForTests({
    watchProcessExit: () => null,
    watchProcessExitWithProof: (_pid, notice) => {
      attempts++
      if (attempts === 2) {
        return null
      }
      signals.push(notice)
      return attempts
    },
    unwatchProcessExit: () => undefined
  })
  const sender = new EventEmitter()
  const readers = new ProviderReceiptReaders(() => 'test')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the window only calls the EventEmitter methods.
  const window = new DesktopProviderReceiptWindow(
    sender as unknown as WebContents,
    readers,
    () => {}
  )
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
    await vi.advanceTimersByTimeAsync(1000)
    expect(attempts).toBe(3)
    signals[0]!(true)
    expect(readers.hasPostedReply(transport.signal)).toBe(true)
    signals[1]!(true)
    signals[1]!(true)
    expect(released).toBe(1)
    expect(readers.hasPostedReply(transport.signal)).toBe(false)
  } finally {
    transport.abort()
    window.dispose()
    setProcessExitWatchNativeForTests(undefined)
    vi.useRealTimers()
  }
})
