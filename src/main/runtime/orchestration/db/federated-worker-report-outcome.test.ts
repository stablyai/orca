import { describe, expect, it } from 'vitest'
import { parseFederatedWorkerReportOutcome } from './federated-worker-report-outcome'

describe('federated-worker-report-outcome', () => {
  it('reads succeeded or failed from a nested report payload', () => {
    const succeeded = JSON.stringify({ payload: JSON.stringify({ outcome: 'succeeded' }) })
    const failed = JSON.stringify({ payload: JSON.stringify({ outcome: 'failed' }) })
    expect(parseFederatedWorkerReportOutcome(succeeded)).toBe('succeeded')
    expect(parseFederatedWorkerReportOutcome(failed)).toBe('failed')
  })

  it('returns undefined for malformed or non-terminal outcomes', () => {
    expect(parseFederatedWorkerReportOutcome('not-json')).toBeUndefined()
    expect(parseFederatedWorkerReportOutcome(JSON.stringify({ payload: {} }))).toBeUndefined()
    const other = JSON.stringify({ payload: JSON.stringify({ outcome: 'running' }) })
    expect(parseFederatedWorkerReportOutcome(other)).toBeUndefined()
  })
})
