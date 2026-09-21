import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileCaptureToTermination } from '../git/command-runner/exec-file-capture'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import {
  AGY_MIN_USAGE_VERSION,
  AGY_USAGE_ARGS,
  AGY_VERSION_ARGS,
  extractAgyVersion,
  fetchAntigravityRateLimits,
  parseAgyUsageResponse
} from './antigravity-usage-fetcher'

vi.mock('../git/command-runner/exec-file-capture', () => ({
  execFileCaptureToTermination: vi.fn()
}))

vi.mock('../../shared/node-cli-command-resolution', () => ({
  resolveCliCommand: vi.fn()
}))

const sample = {
  command: {
    data: {
      groups: [
        {
          name: 'Gemini Models',
          description: 'Gemini quota',
          buckets: [
            {
              id: 'gemini-weekly',
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 0.994,
              reset_time: '2026-09-18T20:00:00Z'
            },
            {
              id: 'gemini-5h',
              name: 'Five Hour Limit Remaining',
              window: '5h',
              remaining_fraction: 1,
              reset_time: '2026-09-14T18:08:00Z'
            }
          ]
        },
        {
          name: 'Claude and GPT models',
          buckets: [
            {
              id: '3p-weekly',
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 1,
              reset_time: null
            },
            {
              id: '3p-5h',
              name: 'Five Hour Limit Remaining',
              window: '5h',
              remaining_fraction: 1,
              reset_time: '2026-09-14T18:08:00Z'
            }
          ]
        }
      ]
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('parseAgyUsageResponse', () => {
  it('preserves two groups and two windows with independent values', () => {
    const result = parseAgyUsageResponse(sample, 1_700_000_000_000)
    expect(result.status).toBe('ok')
    expect(result.buckets).toHaveLength(4)
    expect(
      result.buckets?.map((bucket) => [bucket.id, bucket.groupName, bucket.windowMinutes])
    ).toEqual([
      ['gemini-weekly', 'Gemini Models', 10080],
      ['gemini-5h', 'Gemini Models', 300],
      ['3p-weekly', 'Claude and GPT models', 10080],
      ['3p-5h', 'Claude and GPT models', 300]
    ])
    expect(result.buckets?.[0]?.usedPercent).toBeCloseTo(0.6)
    expect(result.buckets?.[1]?.usedPercent).toBe(0)
    expect(result.buckets?.[2]?.resetsAt).toBeNull()
  })

  it('keeps unknown groups and windows instead of dropping them', () => {
    const result = parseAgyUsageResponse({
      command: {
        data: {
          groups: [
            {
              name: 'New pool',
              buckets: [{ id: 'daily', name: 'Daily', window: 'daily', remaining_fraction: 0.5 }]
            }
          ]
        }
      }
    })
    expect(result.buckets?.[0]).toMatchObject({
      id: 'daily',
      groupName: 'New pool',
      windowLabel: 'daily',
      windowMinutes: 0,
      usedPercent: 50
    })
  })

  it.each([
    { name: 'missing groups', value: {} },
    { name: 'empty groups', value: { command: { data: { groups: [] } } } }
  ])('returns unavailable for $name', ({ value }) => {
    const result = parseAgyUsageResponse(value)
    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
  })

  // Why: a partial read must never present as `ok` — a dropped pool could hide
  // the tightest quota while the status bar reports a successful refresh.
  it.each([
    {
      name: 'partial bucket',
      value: { command: { data: { groups: [{ name: 'x', buckets: [{}] }] } } }
    },
    {
      name: 'group without a name',
      value: {
        command: {
          data: {
            groups: [
              {
                buckets: [{ name: 'x', window: '5h', remaining_fraction: 0.5 }]
              }
            ]
          }
        }
      }
    },
    {
      name: 'bucket without a window',
      value: {
        command: {
          data: {
            groups: [{ name: 'x', buckets: [{ name: 'x', remaining_fraction: 0.5 }] }]
          }
        }
      }
    },
    {
      name: 'one malformed bucket beside a valid one',
      value: {
        command: {
          data: {
            groups: [
              {
                name: 'Gemini Models',
                buckets: [
                  { name: 'Weekly', window: 'weekly', remaining_fraction: 0.5 },
                  { name: 'Broken', window: '5h' }
                ]
              }
            ]
          }
        }
      }
    }
  ])('returns a parse error for $name', ({ value }) => {
    const result = parseAgyUsageResponse(value)
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
  })
})

describe('extractAgyVersion', () => {
  it.each([
    { output: '1.2.4', expected: '1.2.4' },
    { output: 'agy version 1.1.11\n', expected: '1.1.11' },
    { output: 'v1.1.10 (darwin arm64)', expected: '1.1.10' },
    { output: '1.1.11-rc.1', expected: '1.1.11-rc.1' },
    { output: 'agy 1.2.4+build.7', expected: '1.2.4+build.7' }
  ])('reads $output as $expected', ({ output, expected }) => {
    expect(extractAgyVersion(output)).toBe(expected)
  })

  it.each([{ output: '' }, { output: 'agy' }, { output: 'version unknown' }])(
    'returns null for $output',
    ({ output }) => {
      expect(extractAgyVersion(output)).toBeNull()
    }
  )
})

describe('fetchAntigravityRateLimits', () => {
  function mockVersionThenUsage(versionStdout: string, usageStdout: string) {
    vi.mocked(resolveCliCommand).mockReturnValue('/mock/bin/agy')
    vi.mocked(execFileCaptureToTermination)
      .mockResolvedValueOnce({ stdout: versionStdout, stderr: '' })
      .mockResolvedValueOnce({ stdout: usageStdout, stderr: '' })
  }

  function usageInvocations() {
    return vi
      .mocked(execFileCaptureToTermination)
      .mock.calls.filter(([, args]) => args === AGY_USAGE_ARGS)
  }

  it('resolves agy outside PATH and uses the exact argv without a shell', async () => {
    mockVersionThenUsage('1.2.4', JSON.stringify(sample))
    await fetchAntigravityRateLimits()
    expect(execFileCaptureToTermination).toHaveBeenCalledWith(
      '/mock/bin/agy',
      AGY_VERSION_ARGS,
      expect.objectContaining({
        timeout: 5_000,
        signal: undefined,
        createTimeoutError: expect.any(Function)
      })
    )
    expect(execFileCaptureToTermination).toHaveBeenCalledWith(
      '/mock/bin/agy',
      AGY_USAGE_ARGS,
      expect.objectContaining({
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        signal: undefined,
        createTimeoutError: expect.any(Function)
      })
    )
  })

  it('proceeds on the 1.1.11 boundary version', async () => {
    mockVersionThenUsage('1.1.11', JSON.stringify(sample))
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('ok')
    expect(usageInvocations()).toHaveLength(1)
  })

  // Why: agy 1.1.10 answers `-p /usage` with a billable agent turn instead of a
  // quota report, so the usage argv must never be spawned for older CLIs.
  it('never invokes /usage on agy older than 1.1.11', async () => {
    vi.mocked(resolveCliCommand).mockReturnValue('/mock/bin/agy')
    vi.mocked(execFileCaptureToTermination).mockResolvedValueOnce({
      stdout: '1.1.10',
      stderr: ''
    })
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('unavailable')
    expect(result.error).toContain(AGY_MIN_USAGE_VERSION)
    expect(result.error).toContain('1.1.10')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
    expect(vi.mocked(execFileCaptureToTermination).mock.calls).toHaveLength(1)
    expect(usageInvocations()).toHaveLength(0)
  })

  // Why: `hasReachedAppVersion` ranks prereleases below the stable floor, and the
  // extractor preserves the suffix, so an unverified build can never spawn /usage.
  it('never invokes /usage on a prerelease below the stable floor', async () => {
    vi.mocked(resolveCliCommand).mockReturnValue('/mock/bin/agy')
    vi.mocked(execFileCaptureToTermination).mockResolvedValueOnce({
      stdout: '1.1.11-rc.1',
      stderr: ''
    })
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('unavailable')
    expect(result.error).toContain(AGY_MIN_USAGE_VERSION)
    expect(usageInvocations()).toHaveLength(0)
  })

  it.each([{ versionStdout: '' }, { versionStdout: 'version unknown' }])(
    'never invokes /usage when the version is unreadable ($versionStdout)',
    async ({ versionStdout }) => {
      vi.mocked(resolveCliCommand).mockReturnValue('/mock/bin/agy')
      vi.mocked(execFileCaptureToTermination).mockResolvedValueOnce({
        stdout: versionStdout,
        stderr: ''
      })
      const result = await fetchAntigravityRateLimits()
      expect(result.status).toBe('unavailable')
      expect(result.error).toContain(AGY_MIN_USAGE_VERSION)
      expect(usageInvocations()).toHaveLength(0)
    }
  )

  it('never invokes /usage when the version probe fails', async () => {
    vi.mocked(resolveCliCommand).mockReturnValue('/mock/bin/agy')
    vi.mocked(execFileCaptureToTermination).mockRejectedValueOnce(
      Object.assign(new Error('The agy CLI timed out.'), { code: 'ETIMEDOUT' })
    )
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('unavailable')
    expect(usageInvocations()).toHaveLength(0)
  })

  it('distinguishes an unresolved executable', async () => {
    vi.mocked(resolveCliCommand).mockReturnValue('agy')
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('cli-unavailable')
    expect(execFileCaptureToTermination).not.toHaveBeenCalled()
  })

  it('reports malformed stdout as a parse failure', async () => {
    mockVersionThenUsage('1.2.4', '{')
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
  })

  it('passes the refresh AbortSignal to the agy process', async () => {
    vi.mocked(resolveCliCommand).mockReturnValue('/mock/bin/agy')
    const controller = new AbortController()
    vi.mocked(execFileCaptureToTermination)
      .mockResolvedValueOnce({ stdout: '1.2.4', stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify(sample), stderr: '' })
    await fetchAntigravityRateLimits(controller.signal)
    expect(execFileCaptureToTermination).toHaveBeenCalledWith(
      '/mock/bin/agy',
      AGY_VERSION_ARGS,
      expect.objectContaining({ signal: controller.signal })
    )
    expect(execFileCaptureToTermination).toHaveBeenCalledWith(
      '/mock/bin/agy',
      AGY_USAGE_ARGS,
      expect.objectContaining({ signal: controller.signal })
    )
  })

  it('classifies the shared runner timeout separately from a generic read failure', async () => {
    vi.mocked(resolveCliCommand).mockReturnValue('/mock/bin/agy')
    vi.mocked(execFileCaptureToTermination)
      .mockResolvedValueOnce({ stdout: '1.2.4', stderr: '' })
      .mockRejectedValueOnce(
        Object.assign(new Error('The agy CLI timed out.'), {
          code: null,
          killed: true,
          signal: 'SIGTERM'
        })
      )
    const result = await fetchAntigravityRateLimits()
    expect(result.error).toContain('timed out')
    expect(result.usageMetadata?.failureKind).toBe('unknown')
  })

  it('propagates refresh cancellation instead of converting it to a provider error', async () => {
    vi.mocked(resolveCliCommand).mockReturnValue('/mock/bin/agy')
    const abortError = Object.assign(new Error('The operation was aborted.'), {
      name: 'AbortError'
    })
    vi.mocked(execFileCaptureToTermination).mockRejectedValue(abortError)
    await expect(fetchAntigravityRateLimits(new AbortController().signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
  })

  it.each([
    { remaining: -0.1, label: 'below zero' },
    { remaining: 1.1, label: 'above one' }
  ])('rejects remaining_fraction $label as a parse error', ({ remaining }) => {
    const result = parseAgyUsageResponse({
      command: {
        data: {
          groups: [
            { name: 'x', buckets: [{ name: 'x', window: '5h', remaining_fraction: remaining }] }
          ]
        }
      }
    })
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
  })
})
