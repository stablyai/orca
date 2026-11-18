import { describe, expect, it } from 'vitest'
import { webhookRetryDelayMs } from './webhook-call-outcomes'

describe('webhook retries', () => {
  it('thin out to 10 minutes while the cloud keeps failing', () => {
    const top = (failures: number) => webhookRetryDelayMs(failures, null, () => 1)
    expect(top(0)).toBe(1000)
    expect(top(6)).toBe(64_000)
    expect(top(9)).toBe(512_000)
    expect(top(10)).toBe(600_000)
    expect(top(40)).toBe(600_000)
  })
})
