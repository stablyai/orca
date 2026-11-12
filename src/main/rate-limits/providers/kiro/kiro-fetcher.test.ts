import { describe, expect, it } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'
import {
  fetchKiroRateLimits,
  parseKiroUsageOutput,
  type KiroUsageProcessRunner
} from './kiro-fetcher'

const MONTHLY_WINDOW_MINUTES = 43_200

// Real Kiro `/usage` output is ANSI-decorated; the header, credit tuple, and
// percentage arrive on separate visual lines.
const SAMPLE_OUTPUT = [
  '\u001b[1mEstimated Usage\u001b[0m | resets on 2026-10-01 | \u001b[36mKIRO POWER\u001b[0m',
  '\u001b[2mCredits (1,795.12 of 10000 covered in plan)\u001b[0m',
  '\u001b[32m18.0%\u001b[0m'
].join('\n')

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    code: 0,
    signal: null,
    stdout: SAMPLE_OUTPUT,
    stderr: '',
    timedOut: false,
    outputTruncated: false,
    ...overrides
  }
}

describe('parseKiroUsageOutput', () => {
  it('parses ANSI-decorated monthly credit usage', () => {
    const parsed = parseKiroUsageOutput(SAMPLE_OUTPUT)
    expect(parsed.kind).toBe('ok')
    if (parsed.kind !== 'ok') {
      throw new Error('expected ok parse')
    }
    expect(parsed.used).toBeCloseTo(1795.12, 5)
    expect(parsed.limit).toBe(10000)
    expect(parsed.unit).toBe('credits')
    expect(parsed.planType).toBe('KIRO POWER')
    // 1795.12 / 10000 = 17.9512%, computed from exact credits (not the 18.0% line).
    expect(parsed.usedPercent).toBeCloseTo(17.9512, 4)
  })

  it('parses the calendar reset date as a local day boundary', () => {
    const parsed = parseKiroUsageOutput(SAMPLE_OUTPUT)
    if (parsed.kind !== 'ok') {
      throw new Error('expected ok parse')
    }
    const expected = new Date(2026, 9, 1).getTime()
    expect(parsed.resetsAt).toBe(expected)
    expect(parsed.resetDescription).toContain('2026-10-01')
  })

  it('clamps the percentage to 0..100 when credits exceed the plan', () => {
    const output = [
      'Estimated Usage | resets on 2026-10-01 | KIRO POWER',
      'Credits (12000 of 10000 covered in plan)',
      '120%'
    ].join('\n')
    const parsed = parseKiroUsageOutput(output)
    if (parsed.kind !== 'ok') {
      throw new Error('expected ok parse')
    }
    expect(parsed.usedPercent).toBe(100)
  })

  it('accepts thousands separators and decimals in both credit values', () => {
    const output = [
      'Estimated Usage | resets on 2026-12-31 | KIRO PRO',
      'Credits (2,500.50 of 25,000.00 covered in plan)',
      '10%'
    ].join('\n')
    const parsed = parseKiroUsageOutput(output)
    if (parsed.kind !== 'ok') {
      throw new Error('expected ok parse')
    }
    expect(parsed.used).toBeCloseTo(2500.5, 5)
    expect(parsed.limit).toBeCloseTo(25000, 5)
    expect(parsed.planType).toBe('KIRO PRO')
  })

  it('returns a parse error for malformed output with no credit tuple', () => {
    const parsed = parseKiroUsageOutput('welcome to kiro\nnothing useful here')
    expect(parsed.kind).toBe('error')
  })

  it('returns a parse error for a zero limit', () => {
    const parsed = parseKiroUsageOutput(
      'Estimated Usage | resets on 2026-10-01 | KIRO\nCredits (0 of 0 covered in plan)\n0%'
    )
    expect(parsed.kind).toBe('error')
  })

  it('does not invent a total for unlimited output', () => {
    const parsed = parseKiroUsageOutput(
      'Estimated Usage | resets on 2026-10-01 | ENTERPRISE\nCredits (500 used, unlimited)\n'
    )
    expect(parsed.kind).toBe('error')
  })

  it('flags unauthenticated output distinctly', () => {
    const parsed = parseKiroUsageOutput('You are not logged in. Run kiro-cli to sign in.')
    expect(parsed.kind).toBe('unauthenticated')
  })
})

describe('fetchKiroRateLimits', () => {
  it('maps a successful probe to a monthly-only kiro snapshot', async () => {
    const runner: KiroUsageProcessRunner = async () => processResult()
    const snapshot = await fetchKiroRateLimits({ processRunner: runner })
    expect(snapshot.provider).toBe('kiro')
    expect(snapshot.status).toBe('ok')
    expect(snapshot.error).toBeNull()
    expect(snapshot.session).toBeNull()
    expect(snapshot.weekly).toBeNull()
    expect(snapshot.monthly).toEqual({
      usedPercent: expect.closeTo(17.9512, 4),
      windowMinutes: MONTHLY_WINDOW_MINUTES,
      resetsAt: new Date(2026, 9, 1).getTime(),
      resetDescription: expect.stringContaining('2026-10-01')
    })
    expect(snapshot.usageAmount).toEqual({
      used: expect.closeTo(1795.12, 4),
      limit: 10000,
      unit: 'credits'
    })
    expect(snapshot.planType).toBe('KIRO POWER')
    expect(snapshot.usageMetadata?.source).toBe('cli')
  })

  it('accepts successful usage output emitted on stderr by an AppImage-launched Kiro CLI', async () => {
    const runner: KiroUsageProcessRunner = async () =>
      processResult({ stdout: '', stderr: SAMPLE_OUTPUT })
    const snapshot = await fetchKiroRateLimits({ processRunner: runner })
    expect(snapshot.status).toBe('ok')
    expect(snapshot.monthly?.usedPercent).toBeCloseTo(17.9512, 4)
    expect(snapshot.usageAmount).toEqual({
      used: expect.closeTo(1795.12, 4),
      limit: 10000,
      unit: 'credits'
    })
    expect(snapshot.planType).toBe('KIRO POWER')
  })

  it('reports cli-unavailable when the executable is missing', async () => {
    const runner: KiroUsageProcessRunner = async () => {
      const error: NodeJS.ErrnoException = new Error('spawn kiro-cli ENOENT')
      error.code = 'ENOENT'
      throw error
    }
    const snapshot = await fetchKiroRateLimits({ processRunner: runner })
    expect(snapshot.status).toBe('unavailable')
    expect(snapshot.usageMetadata?.failureKind).toBe('cli-unavailable')
  })

  it('reports missing-credentials as unavailable for unauthenticated output', async () => {
    const runner: KiroUsageProcessRunner = async () =>
      processResult({ stdout: 'You are not logged in. Run kiro-cli to sign in.' })
    const snapshot = await fetchKiroRateLimits({ processRunner: runner })
    expect(snapshot.status).toBe('unavailable')
    expect(snapshot.usageMetadata?.failureKind).toBe('missing-credentials')
  })

  it('reports a failed sign-in probe as unavailable instead of a transient failure', async () => {
    const snapshot = await fetchKiroRateLimits({
      processRunner: async () =>
        processResult({
          code: 1,
          stdout: '',
          stderr: 'You are not logged in. Run kiro-cli to sign in.'
        })
    })
    expect(snapshot.status).toBe('unavailable')
    expect(snapshot.usageMetadata?.failureKind).toBe('missing-credentials')
  })

  it('reports a fixed error on timeout without leaking output', async () => {
    const runner: KiroUsageProcessRunner = async () =>
      processResult({ timedOut: true, stdout: 'secret token abc123' })
    const snapshot = await fetchKiroRateLimits({ processRunner: runner })
    expect(snapshot.status).toBe('error')
    expect(snapshot.error).not.toContain('secret token abc123')
    expect(snapshot.error).not.toContain('abc123')
  })

  it('reports a fixed error on truncated output', async () => {
    const runner: KiroUsageProcessRunner = async () =>
      processResult({ outputTruncated: true, stdout: 'secret token abc123' })
    const snapshot = await fetchKiroRateLimits({ processRunner: runner })
    expect(snapshot.status).toBe('error')
    expect(snapshot.error).not.toContain('abc123')
  })

  it('reports a fixed error on a non-zero exit code', async () => {
    const runner: KiroUsageProcessRunner = async () =>
      processResult({ code: 2, stdout: '', stderr: 'boom secret' })
    const snapshot = await fetchKiroRateLimits({ processRunner: runner })
    expect(snapshot.status).toBe('error')
    expect(snapshot.error).not.toContain('boom secret')
  })
})
