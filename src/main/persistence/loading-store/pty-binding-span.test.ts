import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetTracerForTests, setActiveSink } from '../../observability/tracer'
import {
  _resetPtyBindingSpanSamplingForTests,
  PTY_BINDING_FAST_LANE_SPAN_BUDGET_PER_WINDOW,
  spawnCommitBindingOrigin,
  startPtyBindingSpan
} from './pty-binding-span'

let records: unknown[]

beforeEach(() => {
  records = []
  setActiveSink({
    push: (record) => {
      records.push(record)
    },
    flush: () => {},
    close: () => {}
  })
  _resetPtyBindingSpanSamplingForTests()
  vi.useFakeTimers()
  vi.setSystemTime(1_700_000_000_000)
})

afterEach(() => {
  vi.useRealTimers()
  _resetTracerForTests()
})

function finishFastLane(): void {
  const span = startPtyBindingSpan({
    hostKind: 'local',
    origin: 'reattach',
    savePending: false,
    generationGap: 0
  })
  span.setEligibility({ eligible: true, misses: [] })
  span.finish('fast_lane')
}

describe('persistence.pty-binding span', () => {
  it('labels adopted relay bindings as reattach without an isReattach flag', () => {
    expect(spawnCommitBindingOrigin({ agentSessionEnsure: { disposition: 'adopted' } })).toBe(
      'reattach'
    )
  })

  it('records the entry counters, eligibility, and outcome', () => {
    const span = startPtyBindingSpan({
      hostKind: 'ssh',
      origin: 'spawn',
      savePending: true,
      generationGap: 2
    })
    span.setEligibility({ eligible: false, misses: ['tab_pty', 'not_durable'] })
    span.finish('flushed')

    expect(records).toHaveLength(1)
    expect(records[0]).toHaveProperty('name', 'persistence.pty-binding')
    expect(records[0]).toMatchObject({
      attributes: {
        'binding.host': 'ssh',
        'binding.origin': 'spawn',
        'binding.save_pending': true,
        'binding.generation_gap': 2,
        'binding.eligible': false,
        'binding.misses': 'tab_pty,not_durable',
        'binding.outcome': 'flushed'
      }
    })
  })

  it('records a throw as a failed span', () => {
    const span = startPtyBindingSpan({
      hostKind: 'local',
      origin: 'reattach',
      savePending: false,
      generationGap: 0
    })
    span.finish('threw', new Error('disk full'))

    expect(records[0]).toHaveProperty('exit._tag', 'Failure')
    expect(records[0]).toHaveProperty(['attributes', 'binding.outcome'], 'threw')
  })

  it('caps fast-lane spans per window without dropping writes', () => {
    for (let i = 0; i < PTY_BINDING_FAST_LANE_SPAN_BUDGET_PER_WINDOW + 5; i++) {
      finishFastLane()
    }
    expect(records).toHaveLength(PTY_BINDING_FAST_LANE_SPAN_BUDGET_PER_WINDOW)

    // Flushed spans are never dropped, even inside a saturated window.
    const span = startPtyBindingSpan({
      hostKind: 'local',
      origin: 'reattach',
      savePending: false,
      generationGap: 0
    })
    span.finish('flushed')
    expect(records).toHaveLength(PTY_BINDING_FAST_LANE_SPAN_BUDGET_PER_WINDOW + 1)

    vi.setSystemTime(1_700_000_000_000 + 60_000)
    finishFastLane()
    expect(records).toHaveLength(PTY_BINDING_FAST_LANE_SPAN_BUDGET_PER_WINDOW + 2)
  })
})
