import { describe, expect, it } from 'vitest'
import { boundConnectionDiagnosticsReport } from './connection-diagnostics-submission'

describe('submitConnectionDiagnostics', () => {
  it('preserves the newest complete events when bounding a UTF-8 report', () => {
    const report = [
      'Orca Mobile connection diagnostics',
      'State: reconnecting',
      '',
      'Recent connection history (3 events, oldest first):',
      `oldest ${'😀'.repeat(20)}`,
      `middle ${'😀'.repeat(20)}`,
      `newest ${'😀'.repeat(20)}`
    ].join('\n')

    const bounded = boundConnectionDiagnosticsReport(report, 180)

    expect(new TextEncoder().encode(bounded).byteLength).toBeLessThanOrEqual(180)
    expect(bounded).toContain('newest')
    expect(bounded).not.toContain('oldest')
    expect(bounded).toMatch(/older omitted/)
  })

  it('retains a bounded form of the newest event when that event exceeds the budget', () => {
    const report = [
      'Orca Mobile connection diagnostics',
      'State: reconnecting',
      '',
      'Recent connection history (2 events, oldest first):',
      'old event',
      `newest oversized ${'😀'.repeat(1_000)}`
    ].join('\n')

    const bounded = boundConnectionDiagnosticsReport(report, 220)

    expect(new TextEncoder().encode(bounded).byteLength).toBeLessThanOrEqual(220)
    expect(bounded).toContain('newest oversized')
    expect(bounded).toContain('[truncated]')
  })
})
