import { describe, expect, it } from 'vitest'
import type { MessageRow } from '../types'
import {
  classifyWakeReason,
  COORDINATOR_WAKE_MESSAGE_TYPES,
  COORDINATOR_WAKE_REASONS,
  selectWakeEvents,
  shouldWakeCoordinator,
  WAKE_REASON_PAYLOAD_KEY
} from './coordinator-wake-events'

type WakeCandidate = Pick<MessageRow, 'id' | 'type' | 'payload' | 'sequence'>

function message(overrides: Partial<WakeCandidate> = {}): WakeCandidate {
  return { id: 'msg_1', type: 'status', payload: null, sequence: 1, ...overrides }
}

describe('B3 the coordinator wakes only for actionable events', () => {
  it('wakes for worker_done, question and escalation', () => {
    expect(classifyWakeReason(message({ type: 'worker_done' }))).toBe('worker_done')
    expect(classifyWakeReason(message({ type: 'question' }))).toBe('question')
    expect(classifyWakeReason(message({ type: 'escalation' }))).toBe('escalation')
  })

  it('carries STALLED, CRASHED, REVIEW_COMPLETE and CI_BLOCKER as typed escalation reasons', () => {
    for (const reason of ['stalled', 'crashed', 'review_complete', 'ci_blocker'] as const) {
      expect(
        classifyWakeReason(
          message({ type: 'escalation', payload: JSON.stringify({ [WAKE_REASON_PAYLOAD_KEY]: reason }) })
        )
      ).toBe(reason)
    }
  })

  it('covers every declared wake reason', () => {
    expect([...COORDINATOR_WAKE_REASONS].sort()).toEqual(
      ['ci_blocker', 'crashed', 'escalation', 'question', 'review_complete', 'stalled', 'worker_done'].sort()
    )
    expect([...COORDINATOR_WAKE_MESSAGE_TYPES].sort()).toEqual(
      ['escalation', 'question', 'worker_done'].sort()
    )
  })

  it('negative control: status, heartbeat, dispatch, handoff and merge_ready never wake', () => {
    for (const type of ['status', 'heartbeat', 'dispatch', 'handoff', 'merge_ready', 'decision_gate'] as const) {
      expect(classifyWakeReason(message({ type }))).toBeNull()
    }
    expect(shouldWakeCoordinator([message({ type: 'heartbeat' }), message({ type: 'status' })])).toBe(
      false
    )
  })

  it('an empty wait is not a wake event', () => {
    expect(selectWakeEvents([])).toEqual([])
    expect(shouldWakeCoordinator([])).toBe(false)
  })

  it('ignores an unrecognised or malformed wakeReason and falls back to plain escalation', () => {
    expect(
      classifyWakeReason(message({ type: 'escalation', payload: '{"wakeReason":"nonsense"}' }))
    ).toBe('escalation')
    expect(classifyWakeReason(message({ type: 'escalation', payload: 'not json' }))).toBe('escalation')
    // A non-escalation row cannot smuggle itself into the wake set via payload.
    expect(
      classifyWakeReason(message({ type: 'status', payload: '{"wakeReason":"crashed"}' }))
    ).toBeNull()
  })

  it('returns wake events in arrival order with their message identity', () => {
    const events = selectWakeEvents([
      message({ id: 'a', type: 'heartbeat', sequence: 1 }),
      message({ id: 'b', type: 'question', sequence: 2 }),
      message({ id: 'c', type: 'worker_done', sequence: 3 })
    ])
    expect(events).toEqual([
      { reason: 'question', messageId: 'b', sequence: 2 },
      { reason: 'worker_done', messageId: 'c', sequence: 3 }
    ])
  })
})
