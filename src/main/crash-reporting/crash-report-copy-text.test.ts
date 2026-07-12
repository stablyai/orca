import { describe, expect, it } from 'vitest'
import { formatCrashReportCopyText } from './crash-report-copy-text'

describe('formatCrashReportCopyText', () => {
  it('appends only sanitized report and diagnostic omission failure fields', () => {
    const text = formatCrashReportCopyText('[Crash Report]', {
      error: 'proxy failed at C:\\Users\\alice\\Orca',
      diagnosticContext: {
        status: 'not_uploaded',
        reason: 'timeout token=super-secret-value\n- Forged field: hidden',
        internalEndpointError: 'must-not-cross-copy-boundary'
      },
      internalTransportFailure: 'must-not-cross-copy-boundary'
    })

    expect(text).toContain('Submission failure:')
    expect(text).toContain('Report error: proxy failed at [redacted-path]')
    expect(text).toContain('Diagnostic logs not uploaded: timeout token=[redacted]')
    expect(text).not.toContain('\n- Forged field')
    expect(text).not.toContain('alice')
    expect(text).not.toContain('must-not-cross-copy-boundary')
  })

  it('includes a sanitized uploaded ticket without accepting unrelated fields', () => {
    const text = formatCrashReportCopyText('[Crash Report]', {
      error: 'report link failed',
      diagnosticContext: {
        status: 'uploaded',
        ticketId: 'ticket-123',
        bundleSubmissionId: 'not-allow-listed'
      }
    })

    expect(text).toContain('Diagnostic ticket uploaded but not linked: ticket-123')
    expect(text).not.toContain('not-allow-listed')
  })

  it('leaves the report unchanged when failure context is invalid', () => {
    expect(formatCrashReportCopyText('[Crash Report]', { error: '' })).toBe('[Crash Report]')
  })
})
