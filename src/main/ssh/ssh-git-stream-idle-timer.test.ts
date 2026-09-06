import { expect, it, vi } from 'vitest'
import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { requestGitStreamable } from './ssh-git-response-stream-reader'

it.each(['end', 'abort', 'timeout'] as const)(
  'reuses the idle deadline across 1000 chunks and cleans up on %s',
  async (finish) => {
    vi.useFakeTimers()
    const setTimer = vi.spyOn(globalThis, 'setTimeout')
    try {
      const listeners = new Map<string, (params: Record<string, unknown>) => void>()
      const controller = new AbortController()
      const content = 'x'.repeat(998)
      const encoded = Buffer.from(JSON.stringify(content))
      const notify = vi.fn()
      const mux = {
        request: vi.fn(async () => ({
          __orcaGitResponseStream: { streamId: 7, totalBytes: encoded.length, chunkCount: 1000 }
        })),
        isDisposed: () => false,
        notify,
        onDispose: () => () => {},
        onNotificationByMethod: (
          method: string,
          callback: (params: Record<string, unknown>) => void
        ) => {
          listeners.set(method, callback)
          return () => listeners.delete(method)
        }
      }
      const promise = requestGitStreamable(
        mux as unknown as SshChannelMultiplexer,
        'git.diff',
        {},
        {
          signal: controller.signal
        }
      )
      const outcome = promise.then(
        (value) => ({ value }),
        (error: Error) => ({ error: error.message })
      )
      await vi.advanceTimersByTimeAsync(15_000)
      for (let seq = 0; seq < encoded.length; seq++) {
        listeners.get('git.responseChunk')!({
          streamId: 7,
          seq,
          data: encoded.subarray(seq, seq + 1).toString('base64')
        })
      }
      await vi.advanceTimersByTimeAsync(29_999)
      expect(listeners.size).toBe(3)
      expect(notify.mock.calls.filter(([method]) => method === 'git.responseAck')).toHaveLength(
        1000
      )
      const allocations = setTimer.mock.calls.filter(([, delay]) => delay === 30_000).length
      if (finish === 'end') {
        listeners.get('git.responseEnd')!({ streamId: 7 })
        expect(await outcome).toEqual({ value: content })
      } else if (finish === 'abort') {
        controller.abort()
        expect(await outcome).toEqual({ error: 'Request was cancelled' })
      } else {
        await vi.advanceTimersByTimeAsync(1)
        expect(await outcome).toEqual({
          error: 'Git response stream stalled (>30000ms without data)'
        })
      }
      expect(allocations).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
      expect(listeners.size).toBe(0)
      expect(
        notify.mock.calls.filter(([method]) => method === 'git.cancelResponseStream')
      ).toHaveLength(finish === 'end' ? 0 : 1)
    } finally {
      setTimer.mockRestore()
      vi.useRealTimers()
    }
  }
)
