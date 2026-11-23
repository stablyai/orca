import { describe, expect, it } from 'vitest'
import { createPtyDataPayload } from './daemon-pty-listener-emission'

describe('daemon stream sequence compatibility', () => {
  it('only trusts complete sequence stamps from protocol 63 onward', () => {
    const event = {
      type: 'event' as const,
      event: 'data' as const,
      sessionId: 'pty',
      payload: { data: 'x', seq: 5 }
    }
    expect(createPtyDataPayload(event, 62)).toEqual({ id: 'pty', data: 'x' })
    expect(createPtyDataPayload(event, 63)).toEqual({ id: 'pty', data: 'x', seq: 5 })
  })
})
