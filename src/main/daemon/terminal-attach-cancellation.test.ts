import { describe, expect, it, vi } from 'vitest'
import { waitForTerminalAttachOperation } from './terminal-attach-cancellation'

describe('terminal attach cancellation', () => {
  it('removes cancellation listeners when the operation settles first', async () => {
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')

    await expect(
      waitForTerminalAttachOperation(Promise.resolve('ready'), controller.signal, 'session-1')
    ).resolves.toBe('ready')

    expect(removeListener).toHaveBeenCalledTimes(1)
  })

  it('rejects promptly on cancellation while the operation remains pending', async () => {
    const controller = new AbortController()
    const operation = new Promise<void>(() => {})
    const waiting = waitForTerminalAttachOperation(operation, controller.signal, 'session-2')

    controller.abort()

    await expect(waiting).rejects.toMatchObject({ name: 'TerminalAttachCanceledError' })
  })
})
