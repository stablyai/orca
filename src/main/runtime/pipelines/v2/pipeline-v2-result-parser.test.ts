import { expect, it } from 'vitest'
import { parsePipelineV2Result } from './pipeline-v2-result-parser'

it('retains every finding and explanatory annotation without granting approval', () => {
  const result = parsePipelineV2Result(
    JSON.stringify({
      status: 'result',
      outcomeId: 'changes',
      summary: 'Review complete',
      evidence: {
        stage: 'review',
        findings: [
          {
            severity: 'important',
            detail: 'Lease can expire',
            conditionToFix: 'Fence expired leases'
          }
        ],
        verification: 'Tests passed',
        commit: 'abc'
      }
    })
  )
  expect(result).toEqual({
    success: true,
    data: {
      status: 'result',
      outcomeId: 'changes',
      summary: 'Review complete',
      evidence: {
        stage: 'review',
        findings: [
          {
            severity: 'important',
            detail: 'Lease can expire',
            conditionToFix: 'Fence expired leases'
          }
        ]
      },
      explanation: '{"evidenceAnnotations":{"verification":"Tests passed","commit":"abc"}}'
    }
  })
})

it('never infers a missing outcome, hides unrecognized evidence, or coerces findings', () => {
  for (const evidence of [
    { stage: 'review', findings: [] },
    { stage: 'review', findings: [], approval: true },
    { stage: 'review', findings: 'No issues' }
  ]) {
    expect(
      parsePipelineV2Result(JSON.stringify({ status: 'result', summary: 'Done', evidence })).success
    ).toBe(false)
  }
  expect(parsePipelineV2Result('{broken')).toEqual({
    success: false,
    errors: [{ path: '', code: 'invalid_json', message: 'Final response is not valid JSON' }]
  })
  expect(
    parsePipelineV2Result(
      JSON.stringify({
        status: 'result',
        outcomeId: 'approved',
        summary: 'Done',
        evidence: { stage: 'review', findings: [], approval: true }
      })
    ).success
  ).toBe(false)
})
