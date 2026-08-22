import { describe, it, expect } from 'vitest'
import { formatFleetEcho } from './orchestration-fleet-echo-format'

describe('formatFleetEcho', () => {
  it('labels the heartbeat age and marks a lane that has never heartbeated', () => {
    const text = formatFleetEcho({
      runId: 'run_1',
      truncated: false,
      lanes: [
        {
          handle: 'term_a',
          taskId: 'task_1',
          dispatchId: 'ctx_1',
          lifecycle: 'dispatched',
          quietMs: 5_000,
          heartbeatAgeMs: 240_000,
          // Why: a lane needing attention, so the table renders — a healthy fleet collapses
          // to the one-line summary, which carries no per-lane heartbeat.
          delivery: 'not_accepted',
          deliveryEvidence: 'worker_stage',
          processState: 'unknown'
        },
        {
          handle: 'term_b',
          taskId: 'task_2',
          dispatchId: 'ctx_2',
          lifecycle: 'dispatched',
          quietMs: 5_000,
          heartbeatAgeMs: null,
          delivery: 'accepted',
          deliveryEvidence: 'worker_stage',
          processState: 'unknown'
        }
      ]
    })

    // Why: the label is what keeps two adjacent durations from reading as one range.
    expect(text).toContain('hb:4m0s')
    expect(text).toContain('hb:—')
  })

  it('collapses a fleet with nothing to act on into one line', () => {
    const text = formatFleetEcho({
      runId: 'run_1',
      truncated: false,
      lanes: [
        {
          handle: 'term_a',
          taskId: 'task_1',
          dispatchId: 'ctx_1',
          lifecycle: 'dispatched',
          quietMs: 5_000,
          heartbeatAgeMs: null,
          delivery: 'accepted',
          deliveryEvidence: 'worker_stage',
          processState: 'unknown'
        },
        {
          handle: 'term_b',
          taskId: 'task_2',
          dispatchId: 'ctx_2',
          lifecycle: 'dispatched',
          quietMs: 62_000,
          heartbeatAgeMs: null,
          delivery: 'accepted',
          deliveryEvidence: 'worker_stage',
          processState: 'unknown'
        }
      ]
    })

    expect(text).toBe('fleet run_1: 2 lanes, none needing attention, quietest 1m2s')
    // Why: the table itself is the signal that something needs looking at, so a healthy fleet
    // must not print one — otherwise every response repeats an unchanged block.
    expect(text).not.toContain('ctx_1')
  })

  it('opens the full table as soon as one lane needs attention', () => {
    const text = formatFleetEcho({
      runId: 'run_1',
      truncated: false,
      lanes: [
        {
          handle: 'term_a',
          taskId: 'task_1',
          dispatchId: 'ctx_1',
          lifecycle: 'dispatched',
          quietMs: 5_000,
          heartbeatAgeMs: null,
          delivery: 'not_accepted',
          deliveryEvidence: 'terminal_output',
          processState: 'unknown'
        },
        {
          handle: 'term_b',
          taskId: 'task_2',
          dispatchId: 'ctx_2',
          lifecycle: 'dispatched',
          quietMs: 5_000,
          heartbeatAgeMs: null,
          delivery: 'accepted',
          deliveryEvidence: 'worker_stage',
          processState: 'unknown'
        }
      ]
    })

    // Why: the healthy lane still prints — the coordinator needs the roster to reason about
    // the broken one, not just the broken row on its own.
    expect(text).toContain('ctx_1')
    expect(text).toContain('ctx_2')
    expect(text).toContain('NOT_ACCEPTED:output')
  })

  it('does not print the lifecycle column, which delivery already implies', () => {
    const text = formatFleetEcho({
      runId: 'run_1',
      truncated: false,
      lanes: [
        {
          handle: 'term_a',
          taskId: 'task_1',
          dispatchId: 'ctx_1',
          lifecycle: 'dispatched',
          quietMs: 5_000,
          heartbeatAgeMs: null,
          delivery: 'not_accepted',
          deliveryEvidence: 'worker_stage',
          processState: 'unknown'
        }
      ]
    })

    expect(text).not.toContain('dispatched')
  })

  it('says which observation each verdict was read from', () => {
    const text = formatFleetEcho({
      runId: 'run_1',
      truncated: false,
      lanes: [
        {
          handle: 'term_a',
          taskId: 'task_1',
          dispatchId: 'ctx_1',
          lifecycle: 'dispatched',
          quietMs: 5_000,
          heartbeatAgeMs: null,
          delivery: 'accepted',
          deliveryEvidence: 'worker_stage',
          processState: 'live'
        },
        {
          handle: 'term_b',
          taskId: 'task_2',
          dispatchId: 'ctx_2',
          lifecycle: 'dispatched',
          quietMs: 5_000,
          heartbeatAgeMs: null,
          delivery: 'not_accepted',
          deliveryEvidence: 'terminal_output',
          processState: 'live'
        },
        {
          handle: 'term_c',
          taskId: 'task_3',
          dispatchId: 'ctx_3',
          lifecycle: 'pending',
          quietMs: null,
          heartbeatAgeMs: null,
          delivery: 'unknown',
          deliveryEvidence: null,
          processState: 'unknown'
        }
      ]
    })

    expect(text).toContain('accepted:stage')
    // Why: the loud verdict must stay loud with the basis attached, not become a quieter string.
    expect(text).toContain('NOT_ACCEPTED:output')
    // Why: nothing was read, so there is no basis to name — 'unknown:' would imply one existed.
    expect(text).toContain('unknown')
    expect(text).not.toContain('unknown:')
  })

  it('renders one line per lane with a header', () => {
    const text = formatFleetEcho({
      runId: 'run_1',
      truncated: false,
      lanes: [
        {
          handle: 'term_a',
          taskId: 'task_1',
          dispatchId: 'ctx_1',
          lifecycle: 'dispatched',
          quietMs: 5_000,
          heartbeatAgeMs: null,
          // Why: a lane needing attention, because a fleet with nothing to act on renders the
          // one-line summary instead — the table is what this case is about.
          delivery: 'not_accepted',
          deliveryEvidence: 'worker_stage',
          processState: 'live'
        }
      ]
    })

    expect(text).toContain('fleet')
    expect(text).toContain('term_a')
    expect(text).toContain('5s')
    expect(text).toContain('NOT_ACCEPTED')
  })

  it('shouts about a lane whose prompt was never accepted', () => {
    const text = formatFleetEcho({
      runId: 'run_1',
      truncated: false,
      lanes: [
        {
          handle: 'term_c',
          taskId: 'task_3',
          dispatchId: 'ctx_3',
          lifecycle: 'dispatched',
          quietMs: 182_000,
          heartbeatAgeMs: null,
          delivery: 'not_accepted',
          deliveryEvidence: 'worker_stage',
          processState: 'live'
        }
      ]
    })

    expect(text).toContain('NOT_ACCEPTED')
    // Why: pins the >=60s formatQuietMs branch (182_000ms = 3m2s) so its arithmetic can't silently reformat.
    expect(text).toContain('3m2s')
  })

  it('notes truncation', () => {
    const text = formatFleetEcho({
      runId: 'run_1',
      truncated: true,
      lanes: [
        {
          handle: 'term_a',
          taskId: 'task_1',
          dispatchId: 'ctx_1',
          lifecycle: 'dispatched',
          quietMs: null,
          heartbeatAgeMs: null,
          delivery: 'unknown',
          deliveryEvidence: null,
          processState: 'unknown'
        }
      ]
    })

    expect(text).toContain('more')
  })

  it('renders nothing when there are no lanes', () => {
    expect(formatFleetEcho({ runId: 'run_1', truncated: false, lanes: [] })).toBe('')
  })
})
