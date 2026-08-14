import { describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { getSpawnArgsForWindows } from '../win32-utils'
import { fetchKiroRateLimits, parseKiroUsageOutput } from './kiro-usage-fetcher'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
vi.mock('../win32-utils', () => ({ getSpawnArgsForWindows: vi.fn() }))

const KIRO_USAGE_OUTPUT =
  'Estimated Usage | resets on 2026-09-01 | KIRO PRO\nCredits (10 of 100 covered in plan)\n10%'

describe('Kiro usage fetcher', () => {
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

  it('launches configured .cmd shims through the shared Windows batch launcher', async () => {
    vi.mocked(getSpawnArgsForWindows).mockReturnValue({
      spawnCmd: 'C:\\Windows\\System32\\cmd.exe',
      spawnArgs: ['/d', '/c', 'C:\\Users\\me\\bin\\kiro-cli.cmd', 'chat']
    })
    vi.mocked(execFile).mockImplementation(
      ((_command, _args, _options, callback) => {
        callback(null, KIRO_USAGE_OUTPUT, '')
        return undefined as never
      }) as unknown as typeof execFile
    )

    const result = await fetchKiroRateLimits({ command: 'C:\\Users\\me\\bin\\kiro-cli.cmd' })

    expect(getSpawnArgsForWindows).toHaveBeenCalledWith('C:\\Users\\me\\bin\\kiro-cli.cmd', [
      'chat',
      '/usage',
      '--no-interactive',
      '--wrap',
      'never'
    ])
    expect(execFile).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/c', 'C:\\Users\\me\\bin\\kiro-cli.cmd', 'chat'],
      expect.anything(),
      expect.any(Function)
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
