import { describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchKiroRateLimits, parseKiroUsageOutput, resolveKiroCommand } from './kiro-usage-fetcher'

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))

const KIRO_USAGE_OUTPUT =
  'Estimated Usage | resets on 2026-09-01 | KIRO PRO\nCredits (10 of 100 covered in plan)\n10%'

describe('Kiro usage fetcher', () => {
  it('uses the shared CLI resolver for version-manager installs', () => {
    const homePath = mkdtempSync(join(tmpdir(), 'orca-kiro-command-'))
    const command = join(homePath, '.volta', 'bin', 'kiro-cli')
    mkdirSync(join(homePath, '.volta', 'bin'), { recursive: true })
    writeFileSync(command, '#!/bin/sh\n')
    chmodSync(command, 0o755)
    vi.stubEnv('KIRO_CLI_PATH', '')
    try {
      expect(resolveKiroCommand({ platform: 'darwin', pathEnv: '', homePath })).toBe(command)
    } finally {
      vi.unstubAllEnvs()
      rmSync(homePath, { recursive: true, force: true })
    }
  })

  it('parses the official CLI usage command output', () => {
    const result = parseKiroUsageOutput(`
\u001b[1mEstimated Usage | resets on 2026-09-01 | KIRO PRO+\u001b[0m
Credits (1233.74 of 2000 covered in plan)
\u001b[32m████ 61%\u001b[0m
`)

    expect(result).toMatchObject({ provider: 'kiro', status: 'ok', planType: 'KIRO PRO+' })
    expect(result.monthly?.usedPercent).toBeCloseTo(61.687)
    expect(result.monthly).toMatchObject({
      resetsAt: null,
      resetDescription: '2026-09-01'
    })
  })

  it('accepts a Kiro reset description without an ISO date', () => {
    const output =
      'Estimated Usage | resets on 01/01 | KIRO PRO\nCredits (10 of 100 covered in plan)\n10%'

    expect(parseKiroUsageOutput(output)).toMatchObject({
      status: 'ok',
      planType: 'KIRO PRO',
      monthly: { usedPercent: 10, resetsAt: null, resetDescription: '01/01' }
    })
  })

  it('runs the local non-model usage command', async () => {
    const runner = vi.fn().mockResolvedValue({
      stdout: KIRO_USAGE_OUTPUT,
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

  it('uses the shared process wrapper with bounded timeout and cancellation', async () => {
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      stdout: KIRO_USAGE_OUTPUT,
      stderr: '',
      timedOut: false
    })
    const signal = new AbortController().signal
    const command = 'C:\\Users\\me\\bin\\kiro-cli.cmd'
    const result = await fetchKiroRateLimits({ command, signal })
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program: command,
        args: ['chat', '/usage', '--no-interactive', '--wrap', 'never'],
        timeoutMs: 20_000,
        maxOutputBytes: 1024 * 1024,
        killOnOutputLimit: true,
        signal
      })
    )
    expect(result.status).toBe('ok')
  })

  it.each([
    { code: 1, signal: null, timedOut: false },
    { code: 0, signal: null, timedOut: true },
    { code: null, signal: 'SIGTERM' as const, timedOut: false },
    // Why: a capped read can end on a valid-looking line that is not the real total.
    { code: 0, signal: null, timedOut: false, outputTruncated: true }
  ])('rejects unsuccessful process results even with valid output: %j', async (failure) => {
    vi.mocked(runProcess).mockResolvedValue({ ...failure, stdout: KIRO_USAGE_OUTPUT, stderr: '' })
    expect(await fetchKiroRateLimits({ command: '/tmp/kiro-cli' })).toMatchObject({
      status: 'error',
      usageMetadata: { failureKind: 'usage-unavailable' }
    })
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
