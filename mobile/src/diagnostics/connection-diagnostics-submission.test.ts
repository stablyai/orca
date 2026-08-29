import { describe, expect, it, vi } from 'vitest'
import {
  boundConnectionDiagnosticsReport,
  submitConnectionDiagnostics
} from './connection-diagnostics-submission'

describe('submitConnectionDiagnostics', () => {
  it('sends a bounded report through the diagnostics lane', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
    const result = await submitConnectionDiagnostics(
      { report: 'x'.repeat(100_000), appVersion: '0.0.47', platform: 'android 36' },
      fetchImpl
    )

    expect(result).toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://www.onorca.dev/v1/feedback',
      expect.objectContaining({ method: 'POST' })
    )
    const request = fetchImpl.mock.calls[0]?.[1]
    const body = JSON.parse(String(request?.body)) as { feedback: string; submissionType: string }
    expect(body.submissionType).toBe('connection_diagnostics')
    expect(new TextEncoder().encode(body.feedback).byteLength).toBeLessThanOrEqual(64 * 1024)
  })

  it('returns a safe failure for a rejected response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }))
    await expect(
      submitConnectionDiagnostics(
        { report: 'report', appVersion: '0.0.47', platform: 'android' },
        fetchImpl
      )
    ).resolves.toEqual({ ok: false, error: 'status 503' })
  })

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
