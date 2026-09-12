import { expect, it, vi } from 'vitest'
import { waitForPtyDraftInputReady } from './runtime-pty-draft-input-ready'

it('leaves no abort listener when exit subscription reports an already-exited PTY synchronously', async () => {
  const controller = new AbortController()
  const activeAbortListeners = new Set<unknown>()
  const add = controller.signal.addEventListener.bind(controller.signal)
  const remove = controller.signal.removeEventListener.bind(controller.signal)
  vi.spyOn(controller.signal, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'abort') {
      activeAbortListeners.add(listener)
    }
    add(type, listener, options)
  })
  vi.spyOn(controller.signal, 'removeEventListener').mockImplementation(
    (type, listener, options) => {
      if (type === 'abort') {
        activeAbortListeners.delete(listener)
      }
      remove(type, listener, options)
    }
  )
  const unsubscribeData = vi.fn()
  const unsubscribeExit = vi.fn()
  await expect(
    waitForPtyDraftInputReady(
      {
        subscribeToData: () => unsubscribeData,
        subscribeToExit: (_id, listener) => {
          listener()
          return unsubscribeExit
        },
        readRecentOutput: () => undefined
      },
      'exited-pty',
      'codex',
      controller.signal
    )
  ).rejects.toThrow('terminal_exited')
  expect.soft(unsubscribeData).toHaveBeenCalledOnce()
  expect.soft(unsubscribeExit).toHaveBeenCalledOnce()
  expect.soft(activeAbortListeners.size).toBe(0)
})
