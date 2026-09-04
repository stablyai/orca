import { describe, expect, it } from 'vitest'
import { PUSH_LIMITS } from './push-limits.js'
import {
  PushSendRequestSchema,
  PushSendResponseSchema,
  PushSendStatusSchema
} from './send-messages.js'

function notification(): Record<string, unknown> {
  return {
    notificationId: 'note-1',
    notificationSeq: 4,
    notificationEpoch: '5c9e9a1e-0000-4000-8000-000000000000',
    source: 'agent-task-complete',
    agentState: 'needs-input',
    title: 'Agent needs input',
    body: 'Waiting on your answer',
    worktreeId: 'wt-1'
  }
}

describe('send schemas', () => {
  it('accepts a batch at the registration cap and a terminal bell without an id', () => {
    const ids = Array.from({ length: PUSH_LIMITS.maxRegistrationIdsPerSend }, (_, i) => `reg-${i}`)
    expect(
      PushSendRequestSchema.safeParse({ v: 1, registrationIds: ids, notification: notification() })
        .success
    ).toBe(true)
    const { notificationId: _dropped, ...bell } = notification()
    expect(
      PushSendRequestSchema.safeParse({
        v: 1,
        registrationIds: ['reg-1'],
        notification: { ...bell, source: 'terminal-bell', agentState: null }
      }).success
    ).toBe(true)
  })

  it('rejects an oversized batch, over-long copy, and unknown notification keys', () => {
    const ids = Array.from(
      { length: PUSH_LIMITS.maxRegistrationIdsPerSend + 1 },
      (_, i) => `reg-${i}`
    )
    expect(
      PushSendRequestSchema.safeParse({ v: 1, registrationIds: ids, notification: notification() })
        .success
    ).toBe(false)
    expect(
      PushSendRequestSchema.safeParse({
        v: 1,
        registrationIds: ['reg-1'],
        notification: { ...notification(), title: 'x'.repeat(PUSH_LIMITS.titleMaxChars + 1) }
      }).success
    ).toBe(false)
    expect(
      PushSendRequestSchema.safeParse({
        v: 1,
        registrationIds: ['reg-1'],
        notification: { ...notification(), body: 'x'.repeat(PUSH_LIMITS.bodyMaxChars + 1) }
      }).success
    ).toBe(false)
    expect(
      PushSendRequestSchema.safeParse({
        v: 1,
        registrationIds: ['reg-1'],
        notification: { ...notification(), coalescedCount: 2 }
      }).success
    ).toBe(false)
    expect(PushSendRequestSchema.safeParse({ v: 1, registrationIds: [], notification: notification() }).success)
      .toBe(false)
  })

  it('dedupes repeated registration ids and keeps the first-seen order', () => {
    const parsed = PushSendRequestSchema.safeParse({
      v: 1,
      registrationIds: ['reg-b', 'reg-a', 'reg-b', 'reg-c', 'reg-a'],
      notification: notification()
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.registrationIds).toEqual(['reg-b', 'reg-a', 'reg-c'])
  })

  it('counts duplicates against the batch cap before deduping them', () => {
    const ids = Array.from({ length: PUSH_LIMITS.maxRegistrationIdsPerSend + 1 }, () => 'reg-1')
    expect(
      PushSendRequestSchema.safeParse({ v: 1, registrationIds: ids, notification: notification() })
        .success
    ).toBe(false)
  })

  it('locks the send result statuses', () => {
    expect(PushSendStatusSchema.options).toEqual(['queued', 'dead', 'rate_limited', 'error'])
    expect(
      PushSendResponseSchema.safeParse({
        results: [{ registrationId: 'reg-1', status: 'queued' }]
      }).success
    ).toBe(true)
    expect(
      PushSendResponseSchema.safeParse({
        results: [{ registrationId: 'reg-1', status: 'sent' }]
      }).success
    ).toBe(false)
  })
})
