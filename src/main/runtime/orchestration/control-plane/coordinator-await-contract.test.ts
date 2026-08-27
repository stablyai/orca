import { describe, expect, it } from 'vitest'
import type { MessageRow } from '../types'
import {
  AWAIT_DEFAULT_BUDGET_MS,
  AWAIT_MAX_BUDGET_MS,
  AWAIT_MIN_BUDGET_MS,
  AWAIT_SWEEP_INTERVAL_MS,
  clampAwaitBudgetMs,
  resolveAwaitWakeEvents,
  shouldEndAwait
} from './coordinator-await-contract'

function message(overrides: Partial<MessageRow>): MessageRow {
  return {
    id: 'msg_1',
    run_id: 'run_1',
    from_handle: 'term_worker',
    to_handle: 'run:run_1',
    subject: 's',
    body: '',
    type: 'status',
    priority: 'normal',
    thread_id: null,
    payload: null,
    read: 0,
    sequence: 1,
    created_at: '2026-08-27T12:00:00.000Z',
    delivered_at: null,
    sender_pane_key: null,
    ...overrides
  } as MessageRow
}

describe('B3 correction 2: the wait budget is runtime-owned', () => {
  it('defaults to hours, not to a model continuation window', () => {
    expect(clampAwaitBudgetMs(undefined)).toBe(AWAIT_DEFAULT_BUDGET_MS)
    expect(AWAIT_DEFAULT_BUDGET_MS).toBeGreaterThanOrEqual(60 * 60 * 1000)
  })

  it('negative control: no 25, 30 or 60 second value can become the wait budget', () => {
    for (const capped of [25_000, 30_000, 60_000]) {
      expect(clampAwaitBudgetMs(capped)).toBeGreaterThanOrEqual(AWAIT_MIN_BUDGET_MS)
      expect(clampAwaitBudgetMs(capped)).toBeGreaterThanOrEqual(60_000)
    }
    // Anything shorter than one minute is raised to the floor.
    expect(clampAwaitBudgetMs(1_000)).toBe(AWAIT_MIN_BUDGET_MS)
  })

  it('caps a runaway request at the ceiling', () => {
    expect(clampAwaitBudgetMs(Number.MAX_SAFE_INTEGER)).toBe(AWAIT_MAX_BUDGET_MS)
  })

  it('keeps the internal sweep slice far shorter than the budget it lives inside', () => {
    expect(AWAIT_SWEEP_INTERVAL_MS).toBeLessThan(AWAIT_DEFAULT_BUDGET_MS)
  })

  it('ends the wait only for a real wake event', () => {
    expect(shouldEndAwait([])).toBe(false)
    expect(shouldEndAwait([message({ type: 'heartbeat' }), message({ type: 'status' })])).toBe(
      false
    )
    expect(shouldEndAwait([message({ type: 'worker_done' })])).toBe(true)
    expect(shouldEndAwait([message({ type: 'question' })])).toBe(true)
  })

  it('reports the typed liveness reasons as wake events', () => {
    const events = resolveAwaitWakeEvents([
      message({ id: 'a', type: 'escalation', payload: '{"wakeReason":"stalled"}', sequence: 1 }),
      message({ id: 'b', type: 'escalation', payload: '{"wakeReason":"crashed"}', sequence: 2 }),
      message({
        id: 'c',
        type: 'escalation',
        payload: '{"wakeReason":"review_complete"}',
        sequence: 3
      }),
      message({ id: 'd', type: 'escalation', payload: '{"wakeReason":"ci_blocker"}', sequence: 4 })
    ])
    expect(events.map((event) => event.reason)).toEqual([
      'stalled',
      'crashed',
      'review_complete',
      'ci_blocker'
    ])
  })
})
