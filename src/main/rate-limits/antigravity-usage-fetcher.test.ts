import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '../../shared/child-process/run-process'
import { runProcess } from '../../shared/child-process/run-process'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))
vi.mock('../../shared/node-cli-command-resolution', () => ({ resolveCliCommand: vi.fn() }))

const sample = {
  command: {
    data: {
      groups: [
        {
          name: 'Gemini Models',
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

function exited(stdout: string, overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { code: 0, signal: null, stdout, stderr: '', timedOut: false, ...overrides }
}

function mockAgy(version: ProcessResult, usage?: ProcessResult): void {
  vi.mocked(resolveCliCommand).mockReturnValue('/mock/bin/agy')
  vi.mocked(runProcess).mockResolvedValueOnce(version)
  if (usage) {
    vi.mocked(runProcess).mockResolvedValueOnce(usage)
  }
}

function usageInvocations(): unknown[] {
  return vi.mocked(runProcess).mock.calls.filter(([spec]) => spec.args?.includes('/usage'))
}

async function fetchUsage(value: unknown) {
  mockAgy(exited('1.2.9'), exited(JSON.stringify(value)))
  return fetchAntigravityRateLimits()
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('fetchAntigravityRateLimits parsing', () => {
  it('keeps each group and orders its buckets shortest window first', async () => {
    const result = await fetchUsage(sample)
    expect(result.status).toBe('ok')
    expect(
      result.buckets?.map((bucket) => [bucket.id, bucket.groupName, bucket.windowMinutes])
    ).toEqual([
      ['gemini-5h', 'Gemini Models', 300],
      ['gemini-weekly', 'Gemini Models', 10080],
      ['3p-5h', 'Claude and GPT models', 300],
      ['3p-weekly', 'Claude and GPT models', 10080]
    ])
    expect(result.buckets?.[1]?.usedPercent).toBeCloseTo(0.6)
    expect(result.buckets?.[0]?.windowLabel).toBeUndefined()
    expect(result.buckets?.[3]?.resetsAt).toBeNull()
  })

  it('keeps unknown windows, labelled by their source name and sorted last', async () => {
    const result = await fetchUsage({
      command: {
        data: {
          groups: [
            {
              name: 'New pool',
              buckets: [
                { id: 'daily', name: 'Daily', window: 'daily', remaining_fraction: 0.5 },
                { id: '5h', name: 'Five', window: '5h', remaining_fraction: 1 }
              ]
            }
          ]
        }
      }
    })
    expect(result.buckets?.map((bucket) => bucket.id)).toEqual(['5h', 'daily'])
    expect(result.buckets?.[1]).toMatchObject({
      groupName: 'New pool',
      windowLabel: 'daily',
      windowMinutes: 0,
      usedPercent: 50
    })
  })

  it('reports an empty group list as unavailable', async () => {
    const result = await fetchUsage({ command: { data: { groups: [] } } })
    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
  })

  // Why: a partial read must never present as `ok` — a dropped pool could hide the tightest quota.
  it.each([
    { name: 'missing groups', value: { command: { data: {} } } },
    { name: 'missing command', value: {} },
    {
      name: 'partial bucket',
      value: { command: { data: { groups: [{ name: 'x', buckets: [{}] }] } } }
    },
    {
      name: 'group without a name',
      value: {
        command: {
          data: { groups: [{ buckets: [{ name: 'x', window: '5h', remaining_fraction: 0.5 }] }] }
        }
      }
    },
    {
      name: 'bucket without a window',
      value: {
        command: {
          data: { groups: [{ name: 'x', buckets: [{ name: 'x', remaining_fraction: 0.5 }] }] }
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
    },
    {
      name: 'remaining_fraction below zero',
      value: {
        command: {
          data: {
            groups: [
              { name: 'x', buckets: [{ name: 'x', window: '5h', remaining_fraction: -0.1 }] }
            ]
          }
        }
      }
    },
    {
      name: 'remaining_fraction above one',
      value: {
        command: {
          data: {
            groups: [{ name: 'x', buckets: [{ name: 'x', window: '5h', remaining_fraction: 1.1 }] }]
          }
        }
      }
    }
  ])('returns a parse error for $name', async ({ value }) => {
    const result = await fetchUsage(value)
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
  })

  it('reports malformed stdout as a parse failure', async () => {
    mockAgy(exited('1.2.9'), exited('{'))
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
  })
})

describe('fetchAntigravityRateLimits version gate', () => {
  it('probes the resolved agy, then reads usage with the refresh signal', async () => {
    const controller = new AbortController()
    mockAgy(exited('1.1.11'), exited(JSON.stringify(sample)))
    const result = await fetchAntigravityRateLimits(controller.signal)
    expect(result.status).toBe('ok')
    expect(vi.mocked(runProcess).mock.calls.map(([spec]) => [spec.program, spec.args])).toEqual([
      ['/mock/bin/agy', ['--version']],
      ['/mock/bin/agy', ['--print', '/usage', '--output-format', 'json']]
    ])
    for (const [spec] of vi.mocked(runProcess).mock.calls) {
      expect(spec.signal).toBe(controller.signal)
    }
  })

  // Why: agy 1.1.10 answers `/usage` with a billable agent turn, so it must never be spawned.
  it.each([
    { name: 'an older release', version: exited('1.1.10'), found: '1.1.10' },
    { name: 'a prerelease below the floor', version: exited('1.1.11-rc.1'), found: '1.1.11-rc.1' },
    { name: 'unreadable output', version: exited('version unknown'), found: null },
    { name: 'a failed probe', version: exited('1.2.9', { code: 1 }), found: null },
    { name: 'a timed-out probe', version: exited('', { code: null, timedOut: true }), found: null }
  ])('never invokes /usage for $name', async ({ version, found }) => {
    mockAgy(version)
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
    expect(result.error).toContain('1.1.11')
    if (found) {
      expect(result.error).toContain(`found ${found}`)
    }
    expect(usageInvocations()).toHaveLength(0)
  })

  it('never invokes /usage when the version probe cannot start', async () => {
    vi.mocked(resolveCliCommand).mockReturnValue('/mock/bin/agy')
    vi.mocked(runProcess).mockRejectedValueOnce(new Error('spawn EACCES'))
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('unavailable')
    expect(usageInvocations()).toHaveLength(0)
  })

  it('reports an unresolved executable without spawning', async () => {
    vi.mocked(resolveCliCommand).mockReturnValue('agy')
    const result = await fetchAntigravityRateLimits()
    expect(result.status).toBe('unavailable')
    expect(result.usageMetadata?.failureKind).toBe('cli-unavailable')
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('distinguishes a usage timeout from a failed read', async () => {
    mockAgy(exited('1.2.9'), exited('', { code: null, timedOut: true }))
    const timedOut = await fetchAntigravityRateLimits()
    expect(timedOut.status).toBe('error')
    expect(timedOut.error).toContain('timed out')

    mockAgy(exited('1.2.9'), exited('', { code: 2 }))
    const failed = await fetchAntigravityRateLimits()
    expect(failed.status).toBe('error')
    expect(failed.error).not.toContain('timed out')
  })
})
