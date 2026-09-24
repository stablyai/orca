import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileCaptureToTermination } from '../git/command-runner/exec-file-capture'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import {
  AGY_USAGE_ARGS,
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
    { name: 'empty groups', value: { command: { data: { groups: [] } } } },
    {
      name: 'partial bucket',
      value: { command: { data: { groups: [{ name: 'x', buckets: [{}] }] } } }
    }
  ])('returns unavailable for $name', ({ value }) => {
    expect(parseAgyUsageResponse(value).status).toBe('unavailable')
  })
})

describe('fetchAntigravityRateLimits', () => {
  it('resolves agy outside PATH and uses the exact argv without a shell', async () => {
    vi.mocked(resolveCliCommand).mockReturnValue('/mock/bin/agy')
    vi.mocked(execFileCaptureToTermination).mockResolvedValue({
      stdout: JSON.stringify(sample),
      stderr: ''
    })
    await fetchAntigravityRateLimits()
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

  it('distinguishes an unresolved executable', async () => {
    vi.mocked(resolveCliCommand).mockReturnValue('agy')
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('cli-unavailable')
    expect(execFileCaptureToTermination).not.toHaveBeenCalled()
  })

  it('reports malformed stdout as a parse failure', async () => {
    vi.mocked(resolveCliCommand).mockReturnValue('/mock/bin/agy')
    vi.mocked(execFileCaptureToTermination).mockResolvedValue({ stdout: '{', stderr: '' })
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
  })

  it('passes the refresh AbortSignal to the agy process', async () => {
    vi.mocked(resolveCliCommand).mockReturnValue('/mock/bin/agy')
    vi.mocked(execFileCaptureToTermination).mockResolvedValue({
      stdout: JSON.stringify(sample),
      stderr: ''
    })
    const controller = new AbortController()
    await fetchAntigravityRateLimits(controller.signal)
    expect(execFileCaptureToTermination).toHaveBeenCalledWith(
      '/mock/bin/agy',
      AGY_USAGE_ARGS,
      expect.objectContaining({ signal: controller.signal })
    )
  })

  it('classifies the shared runner timeout separately from a generic read failure', async () => {
    vi.mocked(resolveCliCommand).mockReturnValue('/mock/bin/agy')
    vi.mocked(execFileCaptureToTermination).mockRejectedValue(
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
  ])('rejects remaining_fraction $label', ({ remaining }) => {
    const result = parseAgyUsageResponse({
      command: {
        data: {
          groups: [
            { name: 'x', buckets: [{ name: 'x', window: '5h', remaining_fraction: remaining }] }
          ]
        }
      }
    })
    expect(result.status).toBe('unavailable')
  })
})
