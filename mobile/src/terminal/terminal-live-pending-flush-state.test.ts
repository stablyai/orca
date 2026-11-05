import { describe, expect, it, vi } from 'vitest'
import { TERMINAL_LIVE_INPUT_MAX_BYTES } from './terminal-live-input'
import {
  cancelTerminalLivePendingFlush,
  createTerminalLivePendingFlushState,
  queueTerminalLiveMirrorSend,
  waitForTerminalLivePendingFlush
} from './terminal-live-pending-flush-state'

describe('terminal live mirror send queue', () => {
  it.each(['throw', 'reject', 'refuse', 'too-large'] as const)(
    'retires dependent input after a send fails by %s',
    async (failure) => {
      const state = createTerminalLivePendingFlushState()
      const writes: string[] = []
      const onFailure = vi.fn()
      state.onFailure = onFailure
      const sender = (_handle: string, payload: string): Promise<boolean> => {
        writes.push(payload)
        if (writes.length === 1 && failure !== 'too-large') {
          if (failure === 'throw') {
            throw new Error('transport unavailable')
          }
          return failure === 'reject'
            ? Promise.reject(new Error('timeout'))
            : Promise.resolve(false)
        }
        return Promise.resolve(true)
      }
      const first = queueTerminalLiveMirrorSend(
        state,
        'terminal-1',
        failure === 'too-large' ? 'a'.repeat(TERMINAL_LIVE_INPUT_MAX_BYTES + 1) : 'first',
        sender
      )
      const second = queueTerminalLiveMirrorSend(state, 'terminal-1', 'second', sender)

      await waitForTerminalLivePendingFlush(state)

      await expect(Promise.all([first, second])).resolves.toEqual([false, false])
      expect(writes).toEqual(failure === 'too-large' ? [] : ['first'])
      expect(onFailure).toHaveBeenCalledExactlyOnceWith(
        'terminal-1',
        failure === 'too-large' ? 'input-too-large' : 'delivery-unconfirmed'
      )
      expect(state.activeRequests).toEqual([])
      expect(state.pendingBatches).toEqual([])
      await expect(queueTerminalLiveMirrorSend(state, 'terminal-1', 'fresh', sender)).resolves.toBe(
        true
      )
    }
  )

  it('cancels flush waiters before the retired transport acknowledges', async () => {
    const state = createTerminalLivePendingFlushState()
    let releaseRetired = (_sent: boolean): void => {}
    let releaseFresh = (_sent: boolean): void => {}
    const retired = queueTerminalLiveMirrorSend(
      state,
      'retired',
      'old',
      () =>
        new Promise<boolean>((resolve) => {
          releaseRetired = resolve
        })
    )
    let controlResult: boolean | null = null
    const control = waitForTerminalLivePendingFlush(state).then((sent) => {
      controlResult = sent
    })

    cancelTerminalLivePendingFlush(state)
    const fresh = queueTerminalLiveMirrorSend(
      state,
      'fresh',
      'new',
      () =>
        new Promise<boolean>((resolve) => {
          releaseFresh = resolve
        })
    )
    const freshBarrier = waitForTerminalLivePendingFlush(state)
    try {
      await vi.waitFor(() => expect(controlResult).toBe(false))
      await expect(retired).resolves.toBe(false)
      releaseRetired(true)
      await Promise.resolve()
      expect(state.current).toBe(freshBarrier)
      cancelTerminalLivePendingFlush(state)
      await expect(freshBarrier).resolves.toBe(false)
      await expect(fresh).resolves.toBe(false)
    } finally {
      releaseRetired(true)
      releaseFresh(true)
      await control
    }
  })
})
