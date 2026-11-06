import { describe, expect, it } from 'vitest'
import { sameQueuePause } from './structured-agent-session-queued-publication'

describe('comparing queue pauses', () => {
  it('compares a pause by presence before reason, so appearing or clearing is always a change', () => {
    expect(sameQueuePause(null, {})).toBe(false)
    expect(sameQueuePause({}, null)).toBe(false)
    expect(sameQueuePause(null, null)).toBe(true)
    expect(sameQueuePause({ reason: 'stopped' }, { reason: 'stopped' })).toBe(true)
    expect(sameQueuePause({ reason: 'stopped' }, { reason: 'cleared' })).toBe(false)
  })
})
