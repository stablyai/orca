import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { ControlPlaneStore } from './control-plane-store'
import {
  classifyDispatchLiveness,
  DEFAULT_LIVENESS_POLICY,
  readLivenessMarker,
  sweepDispatchLiveness,
  type LivenessEvidence
} from './dispatch-liveness'

const NOW = Date.parse('2026-08-27T12:00:00.000Z')

function evidence(overrides: Partial<LivenessEvidence> = {}): LivenessEvidence {
  return {
    processState: 'running',
    lastActivityAt: '2026-08-27T11:59:30.000Z',
    activeToolCall: false,
    approvedBlockingWaitUntil: null,
    providerExit: null,
    terminalState: 'attached',
    ...overrides
  }
}

describe('B4 the runtime owns liveness', () => {
  it('reads recent output as live and working', () => {
    expect(classifyDispatchLiveness(evidence(), NOW)).toMatchObject({
      verdict: 'live',
      activity: 'working'
    })
  })

  it('reads an active tool call as live even with no recent output', () => {
    expect(
      classifyDispatchLiveness(evidence({ activeToolCall: true, lastActivityAt: null }), NOW)
    ).toMatchObject({ verdict: 'live', activity: 'working' })
  })

  it('reads an approved blocking wait as live, not stalled', () => {
    expect(
      classifyDispatchLiveness(
        evidence({
          lastActivityAt: '2026-08-27T11:00:00.000Z',
          approvedBlockingWaitUntil: '2026-08-27T12:30:00.000Z'
        }),
        NOW
      )
    ).toMatchObject({ verdict: 'live', activity: 'blocked_on_approved_wait' })
  })

  it('reads long silence with no tool call and no approved wait as stalled', () => {
    expect(
      classifyDispatchLiveness(evidence({ lastActivityAt: '2026-08-27T11:30:00.000Z' }), NOW)
    ).toMatchObject({ verdict: 'live', activity: 'stalled' })
  })

  it('reads a provider exit and a closed terminal as crashed and terminal', () => {
    expect(
      classifyDispatchLiveness(evidence({ providerExit: { code: 137, signal: null } }), NOW)
    ).toMatchObject({ verdict: 'exited', activity: 'crashed', terminal: true })
    expect(classifyDispatchLiveness(evidence({ terminalState: 'closed' }), NOW)).toMatchObject({
      verdict: 'exited',
      activity: 'crashed',
      terminal: true
    })
  })

  it('never turns loss of contact into an exit verdict', () => {
    expect(classifyDispatchLiveness(evidence({ processState: 'unknown' }), NOW)).toMatchObject({
      verdict: 'unverifiable'
    })
    expect(
      classifyDispatchLiveness(evidence({ processState: 'running', lastActivityAt: null }), NOW)
    ).toMatchObject({ verdict: 'unverifiable' })
  })

  it('resolves a settled Dispatch as terminal', () => {
    expect(classifyDispatchLiveness(evidence({ settled: true }), NOW)).toMatchObject({
      verdict: 'exited',
      activity: 'settled',
      terminal: true
    })
  })
})

describe('B4 sweep, marker and wake behaviour', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  function store(): ControlPlaneStore {
    db = new OrchestrationDb(':memory:')
    return new ControlPlaneStore(db)
  }

  it('wakes the coordinator once on the transition into stalled and not again', () => {
    const cp = store()
    const stalled = evidence({ lastActivityAt: '2026-08-27T11:30:00.000Z' })
    const first = sweepDispatchLiveness(cp, [{ dispatchId: 'ctx_1', evidence: stalled }], NOW)
    expect(first.wakes).toEqual([
      expect.objectContaining({ dispatchId: 'ctx_1', reason: 'stalled' })
    ])
    const second = sweepDispatchLiveness(
      cp,
      [{ dispatchId: 'ctx_1', evidence: stalled }],
      NOW + 1000
    )
    expect(second.wakes).toEqual([])
  })

  it('wakes on a crash and freezes the marker terminally', () => {
    const cp = store()
    const crashed = sweepDispatchLiveness(
      cp,
      [{ dispatchId: 'ctx_1', evidence: evidence({ providerExit: { code: 1, signal: null } }) }],
      NOW
    )
    expect(crashed.wakes).toEqual([expect.objectContaining({ reason: 'crashed' })])
    // A later sweep with healthy evidence must not resurrect the Dispatch.
    const after = sweepDispatchLiveness(
      cp,
      [{ dispatchId: 'ctx_1', evidence: evidence() }],
      NOW + 5000
    )
    expect(after.markers[0]).toMatchObject({ activity: 'crashed', terminal: 1 })
    expect(after.wakes).toEqual([])
  })

  it('negative control: a healthy sweep produces no wake at all', () => {
    const cp = store()
    expect(
      sweepDispatchLiveness(cp, [{ dispatchId: 'ctx_1', evidence: evidence() }], NOW).wakes
    ).toEqual([])
  })

  it('re-arms the marker expiry on every sweep and degrades to unverifiable once it lapses', () => {
    const cp = store()
    sweepDispatchLiveness(cp, [{ dispatchId: 'ctx_1', evidence: evidence() }], NOW)
    expect(readLivenessMarker(cp, 'ctx_1', NOW + 1000)).toMatchObject({
      verdict: 'live',
      expired: false
    })
    const lapsed = NOW + DEFAULT_LIVENESS_POLICY.markerTtlMs + 1
    expect(readLivenessMarker(cp, 'ctx_1', lapsed)).toMatchObject({
      verdict: 'unverifiable',
      expired: true
    })
    // Re-arming with a fresh sweep restores the live verdict.
    sweepDispatchLiveness(
      cp,
      [{ dispatchId: 'ctx_1', evidence: evidence({ activeToolCall: true }) }],
      lapsed
    )
    expect(readLivenessMarker(cp, 'ctx_1', lapsed + 10)).toMatchObject({ verdict: 'live' })
  })

  it('reports an unwritten marker as unverifiable rather than assuming health', () => {
    const cp = store()
    expect(readLivenessMarker(cp, 'ctx_missing', NOW)).toMatchObject({ verdict: 'unverifiable' })
  })

  it('is idempotent under a concurrent duplicate sweep of the same Dispatch', () => {
    const cp = store()
    const inputs = [{ dispatchId: 'ctx_1', evidence: evidence() }]
    sweepDispatchLiveness(cp, inputs, NOW)
    const repeat = sweepDispatchLiveness(cp, inputs, NOW)
    expect(repeat.markers).toHaveLength(1)
    expect(cp.getLivenessMarker('ctx_1')?.observed_at).toBe(new Date(NOW).toISOString())
  })
})
