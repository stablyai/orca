import { describe, expect, it } from 'vitest'
import { AssignmentRequestSchema, AssignmentResponseSchema } from './director-messages.js'
import { DrainSchema } from './control-messages.js'
import { RegionCorrectionRequestSchema } from './region-correction.js'

const report = {
  v: 1,
  action: 'report',
  generation: 3,
  assignmentEpoch: 7,
  policyVersion: 1,
  outcome: 'conclusive',
  measurements: { 'us-central1': 40, 'asia-east2': 180 }
}
const retention = {
  mode: 'finish-existing',
  attemptId: '11111111-1111-4111-8111-111111111111',
  sourceGeneration: 3,
  sourceAssignmentEpoch: 7
}

describe('region correction wire boundaries', () => {
  it('keeps legacy assignment shapes readable without negotiated fields', () => {
    expect(
      AssignmentRequestSchema.parse({ v: 1, relayHostId: 'abcdefghijklmnop' })
    ).not.toHaveProperty('regionCorrection')
    expect(
      AssignmentResponseSchema.parse({
        v: 1,
        cellUrl: 'https://cell.example',
        assignmentEpoch: 1,
        lease: 'synthetic-lease'
      })
    ).not.toHaveProperty('regionCorrection')
  })

  it('accepts complete comparison evidence and explicit inconclusive reports', () => {
    expect(RegionCorrectionRequestSchema.safeParse(report).success).toBe(true)
    const { measurements: _measurements, ...basis } = report
    expect(
      RegionCorrectionRequestSchema.safeParse({
        ...basis,
        outcome: 'inconclusive',
        reason: 'probe-unavailable'
      }).success
    ).toBe(true)
  })

  it.each([
    { measurements: { 'us-central1': 40 } },
    { measurements: { 'us-central1': -1, 'asia-east2': 10 } },
    { measurements: { 'us-central1': Infinity, 'asia-east2': 10 } },
    { measurements: { 'us-central1': 120_001, 'asia-east2': 10 } },
    { generation: Number.MAX_SAFE_INTEGER + 1 },
    { assignmentEpoch: 1.2 },
    { policyVersion: 2 },
    { outcome: 'inconclusive', reason: 'timeout' }
  ])('rejects ambiguous or unbounded evidence: %j', (override) => {
    expect(RegionCorrectionRequestSchema.safeParse({ ...report, ...override }).success).toBe(false)
  })

  it('rejects reporting and issuing a window in the same request', () => {
    expect(
      RegionCorrectionRequestSchema.safeParse({
        ...report,
        action: 'issue-window'
      }).success
    ).toBe(false)
  })

  it('uses ordinary drain and rejects the superseded retention extension', () => {
    const ordinary = { graceMs: 0, recovery: 'resolve-director' }
    expect(DrainSchema.parse(ordinary)).toEqual(ordinary)
    expect(DrainSchema.safeParse({ ...ordinary, retention }).success).toBe(false)
  })
})
