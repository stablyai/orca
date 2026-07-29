import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_TIMER_DELAY_MS } from '../shared/timer-delay'
import { RelayDispatcher } from './dispatcher'

describe('RelayDispatcher request timeout validation', () => {
  let dispatcher: RelayDispatcher
  let writes: Buffer[]

  beforeEach(() => {
    vi.useFakeTimers()
    writes = []
    dispatcher = new RelayDispatcher((data) => {
      writes.push(Buffer.from(data))
    })
  })

  afterEach(() => {
    dispatcher.dispose()
    vi.useRealTimers()
  })

  it.each([-1, 1.5, MAX_TIMER_DELAY_MS + 1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid timer delay %s without sending a frame',
    async (timeoutMs) => {
      await expect(
        dispatcher.requestPrimary('status.get', undefined, { timeoutMs })
      ).rejects.toThrow(/Request timeout/)
      expect(writes).toHaveLength(0)
    }
  )
})
