import { expect, it } from 'vitest'
import { SshResponsePendingFrames } from './ssh-response-pending-frames'

it('bounds encoded bytes before retaining oversized payloads or extra fields', () => {
  const pending = new SshResponsePendingFrames(64)
  pending.push('chunk', { streamId: 1, seq: 0, data: 'x'.repeat(1024 * 1024) })
  expect(pending.retainedBytes).toBe(0)
  expect(pending.lostFrames(1)).toBe(true)
  pending.push('chunk', { streamId: 2, seq: 0, data: 'e30=', unrelated: 'x'.repeat(1024 * 1024) })
  expect(pending.shift()?.params).toEqual({ streamId: 2, seq: 0, data: 'e30=' })
  expect(pending.lostFrames(2)).toBe(false)
})

it('bounds chunked retention and releases backing references on clear', () => {
  const pending = new SshResponsePendingFrames(64)
  for (let seq = 0; seq < 1000; seq++) {
    pending.push('chunk', { streamId: 1, seq, data: 'x'.repeat(40) })
    expect(pending.retainedBytes).toBeLessThanOrEqual(pending.maxEncodedBytes)
  }
  expect(pending.lostFrames(1)).toBe(true)
  pending.clear()
  expect(pending.retainedBytes).toBe(0)
  expect(pending.shift()).toBeUndefined()
  expect(pending.lostFrames(1)).toBe(false)
})

it('bounds loss evidence and refuses ambiguous success after evidence overflow', () => {
  const pending = new SshResponsePendingFrames(0)
  for (let streamId = 0; streamId < 10000; streamId++) {
    pending.push('chunk', { streamId, data: 'x' })
    pending.push('chunk', { streamId: 'x'.repeat(1000), data: 'x' })
  }
  expect(pending.retainedBytes).toBe(0)
  expect(pending.lostFrames(10001)).toBe(true)
})
