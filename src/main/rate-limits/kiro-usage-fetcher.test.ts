import { describe, expect, it, vi } from 'vitest'
import { fetchKiroRateLimits, parseKiroUsageOutput } from './kiro-usage-fetcher'

describe('Kiro usage fetcher', () => {
  it('parses the official CLI usage command output', () => {
    const result = parseKiroUsageOutput(`
\u001b[1mEstimated Usage | resets on 2026-09-01 | KIRO PRO+\u001b[0m
Credits (1233.74 of 2000 covered in plan)
\u001b[32m████ 61%\u001b[0m
`)

    expect(result).toMatchObject({ provider: 'kiro', status: 'ok', planType: 'KIRO PRO+' })
    expect(result.monthly?.usedPercent).toBeCloseTo(61.687)
    expect(result.monthly?.resetsAt).toBe(Date.parse('2026-09-01T00:00:00.000Z'))
  })

  it('runs the local non-model usage command', async () => {
    const runner = vi.fn().mockResolvedValue({
      stdout:
        'Estimated Usage | resets on 2026-09-01 | KIRO PRO\nCredits (10 of 100 covered in plan)\n10%',
      stderr: ''
    })

    const result = await fetchKiroRateLimits({ command: '/tmp/kiro-cli', runner })

    expect(runner).toHaveBeenCalledWith(
      '/tmp/kiro-cli',
      ['chat', '/usage', '--no-interactive', '--wrap', 'never'],
      undefined
    )
    expect(result.status).toBe('ok')
  })

  it('fails closed on unexpected output', () => {
    expect(parseKiroUsageOutput('Please sign in first')).toMatchObject({
      provider: 'kiro',
      status: 'error',
      usageMetadata: { failureKind: 'parse' }
    })
  })

  it('reports a missing CLI without exposing process details', async () => {
    const error = Object.assign(new Error('spawn /secret/path ENOENT'), { code: 'ENOENT' })
    const result = await fetchKiroRateLimits({ runner: vi.fn().mockRejectedValue(error) })

    expect(result).toMatchObject({ status: 'unavailable', error: 'Kiro CLI is not installed' })
    expect(JSON.stringify(result)).not.toContain('/secret/path')
  })

  it('distinguishes a failed usage command from a missing CLI', async () => {
    const result = await fetchKiroRateLimits({
      runner: vi.fn().mockRejectedValue(new Error('command timed out'))
    })

    expect(result).toMatchObject({
      status: 'error',
      error: 'Kiro usage command failed',
      usageMetadata: { failureKind: 'usage-unavailable' }
    })
    expect(JSON.stringify(result)).not.toContain('command timed out')
  })
})
