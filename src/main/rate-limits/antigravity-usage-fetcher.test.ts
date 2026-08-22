import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import {
  fetchAntigravityRateLimits,
  parseAntigravityUsageOutput
} from './antigravity-usage-fetcher'

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))
vi.mock('../../shared/node-cli-command-resolution', () => ({ resolveCliCommand: vi.fn() }))

const usagePayload = JSON.stringify({
  status: 'SUCCESS',
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            {
              id: 'gemini-weekly',
              remaining_fraction: 0.98,
              reset_time: '2026-08-29T12:00:00Z'
            },
            {
              id: 'gemini-5h',
              remaining_fraction: 0.91,
              reset_time: '2026-08-22T16:00:00Z'
            }
          ]
        },
        {
          name: 'Claude and GPT models',
          buckets: [
            {
              id: '3p-weekly',
              remaining_fraction: 1,
              reset_time: '2026-08-29T13:00:00Z'
            },
            {
              id: '3p-5h',
              remaining_fraction: 0.995,
              reset_time: '2026-08-22T17:00:00Z'
            }
          ]
        }
      ]
    }
  }
})

describe('parseAntigravityUsageOutput', () => {
  it('preserves all four native quota identities', () => {
    expect(parseAntigravityUsageOutput(usagePayload)).toEqual([
      {
        name: 'Gemini weekly',
        usedPercent: 2,
        windowMinutes: 10_080,
        resetsAt: Date.parse('2026-08-29T12:00:00Z'),
        resetDescription: null
      },
      {
        name: 'Gemini 5h',
        usedPercent: 9,
        windowMinutes: 300,
        resetsAt: Date.parse('2026-08-22T16:00:00Z'),
        resetDescription: null
      },
      {
        name: 'Claude/GPT weekly',
        usedPercent: 0,
        windowMinutes: 10_080,
        resetsAt: Date.parse('2026-08-29T13:00:00Z'),
        resetDescription: null
      },
      {
        name: 'Claude/GPT 5h',
        usedPercent: 1,
        windowMinutes: 300,
        resetsAt: Date.parse('2026-08-22T17:00:00Z'),
        resetDescription: null
      }
    ])
  })

  it('ignores unknown buckets and keeps partial recognized data', () => {
    const payload = JSON.stringify({
      status: 'SUCCESS',
      command: {
        name: 'usage',
        data: {
          groups: [
            {
              buckets: [
                { id: 'future-window', remaining_fraction: 0.5 },
                { id: 'gemini-5h', remaining_fraction: 0.4, reset_time: 'invalid' }
              ]
            }
          ]
        }
      }
    })

    expect(parseAntigravityUsageOutput(payload)).toEqual([
      {
        name: 'Gemini 5h',
        usedPercent: 60,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      }
    ])
  })

  it.each([
    ['non-JSON output', 'not JSON'],
    ['a non-usage command', JSON.stringify({ status: 'SUCCESS', command: { name: 'models' } })],
    [
      'no recognized buckets',
      JSON.stringify({
        status: 'SUCCESS',
        command: { name: 'usage', data: { groups: [{ buckets: [] }] } }
      })
    ]
  ])('rejects %s', (_name, output) => {
    expect(() => parseAntigravityUsageOutput(output)).toThrow()
  })
})

describe('fetchAntigravityRateLimits', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(resolveCliCommand).mockReturnValue('C:\\Agy\\agy.exe')
  })

  it('runs Agy print mode and returns native quota summaries', async () => {
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      stdout: usagePayload,
      stderr: '',
      timedOut: false
    })
    const controller = new AbortController()

    const result = await fetchAntigravityRateLimits({ signal: controller.signal })

    expect(resolveCliCommand).toHaveBeenCalledWith('agy')
    expect(runProcess).toHaveBeenCalledWith({
      program: 'C:\\Agy\\agy.exe',
      args: ['-p', '/usage', '--output-format', 'json', '--print-timeout', '20s'],
      timeoutMs: 25_000,
      maxOutputBytes: 1024 * 1024,
      signal: controller.signal
    })
    expect(result).toMatchObject({
      provider: 'antigravity',
      status: 'ok',
      error: null,
      session: { usedPercent: 9, windowMinutes: 300 },
      weekly: null,
      usageMetadata: { source: 'cli', attemptedSources: ['cli'] }
    })
    expect(result.buckets).toHaveLength(4)
  })

  it('reports a missing Agy executable as unavailable', async () => {
    vi.mocked(runProcess).mockRejectedValue(
      Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    )

    await expect(fetchAntigravityRateLimits()).resolves.toMatchObject({
      provider: 'antigravity',
      status: 'unavailable',
      error: 'Antigravity CLI not found',
      usageMetadata: { failureKind: 'cli-unavailable' }
    })
  })

  it('reports command timeouts without parsing partial output', async () => {
    vi.mocked(runProcess).mockResolvedValue({
      code: null,
      signal: 'SIGTERM',
      stdout: usagePayload,
      stderr: '',
      timedOut: true
    })

    await expect(fetchAntigravityRateLimits()).resolves.toMatchObject({
      status: 'error',
      error: 'Agy usage request timed out',
      usageMetadata: { failureKind: 'usage-unavailable' }
    })
  })

  it('classifies malformed successful output as a parse failure', async () => {
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '{}',
      stderr: '',
      timedOut: false
    })

    await expect(fetchAntigravityRateLimits()).resolves.toMatchObject({
      status: 'error',
      usageMetadata: { failureKind: 'parse' }
    })
  })
})
