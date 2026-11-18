import { describe, expect, it } from 'vitest'
import { webhookRetryDelayMs } from './webhook-call-outcomes'

describe('webhook retries', () => {
  it('caps repeated retries at ten minutes', () => {
    expect(webhookRetryDelayMs(10, null, () => 1)).toBe(600_000)
  })
})
