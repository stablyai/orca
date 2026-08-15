import { describe, expect, it, vi } from 'vitest'
import { CDP_FOCUS_EMULATION_METHOD, enableCdpFocusEmulation } from './cdp-focus-emulation'

describe('enableCdpFocusEmulation', () => {
  it('enables Emulation.setFocusEmulationEnabled over CDP', async () => {
    const send = vi.fn(async () => ({}))

    await enableCdpFocusEmulation(send)

    expect(send).toHaveBeenCalledWith(CDP_FOCUS_EMULATION_METHOD, { enabled: true })
  })

  it('bounds a stalled debugger command', async () => {
    vi.useFakeTimers()
    try {
      const send = vi.fn(() => new Promise<unknown>(() => {}))
      const result = enableCdpFocusEmulation(send)
      const expectation = expect(result).rejects.toThrow('CDP focus emulation timed out')

      await vi.advanceTimersByTimeAsync(5_000)

      await expectation
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
