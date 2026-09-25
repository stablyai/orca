import { describe, expect, it } from 'vitest'
import {
  nextBrowserHostReconnectDelay,
  resolveBrowserHostReconnectDelay
} from './browser-host-lease-reconnect-delay'

describe('browser host lease reconnect delay', () => {
  it('uses deterministic client-specific jitter within exponential and grace bounds', () => {
    const delays = Array.from({ length: 8 }, (_, attempt) =>
      nextBrowserHostReconnectDelay({
        baseDelayMs: 100,
        attempt,
        remainingMs: 15_000,
        browserHostClientId: 'host-a'
      })
    )

    expect(delays).toEqual(
      delays.map((_, attempt) =>
        nextBrowserHostReconnectDelay({
          baseDelayMs: 100,
          attempt,
          remainingMs: 15_000,
          browserHostClientId: 'host-a'
        })
      )
    )
    expect(delays[0]).toBeGreaterThanOrEqual(50)
    expect(delays[0]).toBeLessThanOrEqual(100)
    expect(Math.max(...delays)).toBeLessThanOrEqual(2_000)
    expect(
      nextBrowserHostReconnectDelay({
        baseDelayMs: 100,
        attempt: 8,
        remainingMs: 37,
        browserHostClientId: 'host-b'
      })
    ).toBe(37)
  })

  it('rejects invalid timer delays', () => {
    expect(resolveBrowserHostReconnectDelay(undefined)).toBe(100)
    expect(() => resolveBrowserHostReconnectDelay(0)).toThrow(
      'Browser host reconnect delay is invalid'
    )
  })
})
