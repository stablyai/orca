import { expect, it, vi } from 'vitest'
import { FeishuPairing } from './feishu-pairing'

it.each([true, false])(
  'finishes an in-flight pairing write before expiry decides the outcome (%s)',
  async (success) => {
    vi.useFakeTimers()
    try {
      const expired = vi.fn()
      const challenge = new FeishuPairing(expired)
      const write = Promise.withResolvers<boolean>()
      const pending = challenge.commit(() => write.promise)
      vi.advanceTimersByTime(5 * 60_000)
      expect(expired).not.toHaveBeenCalled()
      expect(challenge.matches(challenge.text)).toBe(false)
      write.resolve(success)
      expect(await pending).toBe(success)
      expect(expired).toHaveBeenCalledTimes(success ? 0 : 1)
    } finally {
      vi.useRealTimers()
    }
  }
)
