import { describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-connection-utils', () => ({
  createSshOperationAbortError: () =>
    Object.assign(new Error('SSH operation was cancelled'), { name: 'AbortError' })
}))

import { waitForRelayPollDelay } from './ssh-relay-poll-delay'

describe('waitForRelayPollDelay', () => {
  it('resolves after the delay when no signal is given', async () => {
    vi.useFakeTimers()
    try {
      const settled = vi.fn()
      const pending = waitForRelayPollDelay(200).then(settled)
      expect(settled).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(200)
      await pending
      expect(settled).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(waitForRelayPollDelay(60_000, controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
  })

  it('rejects as soon as the signal fires mid-wait', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const pending = waitForRelayPollDelay(60_000, controller.signal)
      const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      controller.abort()
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves no abort listener behind once the delay elapses', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const removeSpy = vi.spyOn(controller.signal, 'removeEventListener')
      const pending = waitForRelayPollDelay(50, controller.signal)
      await vi.advanceTimersByTimeAsync(50)
      await pending
      expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))
    } finally {
      vi.useRealTimers()
    }
  })
})
