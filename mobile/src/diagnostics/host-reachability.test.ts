import { describe, expect, it, vi } from 'vitest'
import { testHostReachability } from './host-reachability'

describe('testHostReachability', () => {
  it('returns false without leaving timers when WebSocket rejects a malformed endpoint', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor() {
          throw new TypeError('Invalid URL')
        }
      }
    )

    try {
      await expect(testHostReachability('not-a-url')).resolves.toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})
