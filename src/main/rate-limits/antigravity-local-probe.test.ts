import { describe, expect, it, vi } from 'vitest'
import { scanPlatformListeningPorts } from '../ports/local-workspace-platform-port-scanner'
vi.mock('../ports/local-workspace-platform-port-scanner', () => ({
  scanPlatformListeningPorts: vi.fn()
}))
import {
  parseAntigravityQuotaSummary,
  parseAntigravityUserPlan,
  selectAntigravityLocalServer,
  probeLocalAntigravityLanguageServer
} from './antigravity-local-probe'

const sampleQuotaSummaryResponse = {
  response: {
    groups: [
      {
        displayName: 'Gemini Models',
        description: 'Models within this group: Gemini Flash, Gemini Pro',
        buckets: [
          {
            bucketId: 'gemini-weekly',
            displayName: 'Weekly Limit Remaining',
            description: 'Weekly quota refresh',
            window: 'weekly',
            remainingFraction: 0.788,
            resetTime: '2026-09-29T23:37:07Z'
          },
          {
            bucketId: 'gemini-5h',
            displayName: 'Five Hour Limit Remaining',
            description: 'Five hour quota refresh',
            window: '5h',
            remainingFraction: 0.927,
            resetTime: '2026-09-24T01:38:43Z'
          }
        ]
      },
      {
        displayName: 'Claude and GPT models',
        description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
        buckets: [
          {
            bucketId: '3p-weekly',
            displayName: 'Weekly Limit Remaining',
            window: 'weekly',
            remainingFraction: 0.95,
            resetTime: '2026-09-30T00:24:39Z'
          },
          {
            bucketId: '3p-5h',
            displayName: 'Five Hour Limit Remaining',
            window: '5h',
            remainingFraction: 1,
            resetTime: '2026-09-24T02:50:24Z'
          }
        ]
      }
    ]
  }
}

describe('parseAntigravityQuotaSummary', () => {
  it('does not invent remaining quota for missing, disabled or out-of-range buckets', () => {
    for (const bucket of [
      {},
      { remainingFraction: -0.1 },
      { remainingFraction: 1.1 },
      { remainingFraction: 1, disabled: true }
    ]) {
      expect(
        parseAntigravityQuotaSummary({ groups: [{ buckets: [{ window: '5h', ...bucket }] }] })
      ).toEqual({ session: null, weekly: null })
    }
  })
  it('extracts both 5h session and weekly windows separately', () => {
    const parsed = parseAntigravityQuotaSummary(sampleQuotaSummaryResponse)

    expect(parsed.session).toEqual({
      usedPercent: 7, // 1 - 0.927 = 0.073 => 7%
      windowMinutes: 300,
      resetsAt: new Date('2026-09-24T01:38:43Z').getTime(),
      resetDescription: null
    })

    expect(parsed.weekly).toEqual({
      usedPercent: 21, // 1 - 0.788 = 0.212 => 21%
      windowMinutes: 10080,
      resetsAt: new Date('2026-09-29T23:37:07Z').getTime(),
      resetDescription: null
    })
  })

  it('selects the most constrained window across groups', () => {
    const responseWithHigh3pUsage = {
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              {
                window: '5h',
                remainingFraction: 0.9,
                resetTime: '2026-09-24T01:00:00Z'
              },
              {
                window: 'weekly',
                remainingFraction: 0.8,
                resetTime: '2026-09-30T00:00:00Z'
              }
            ]
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [
              {
                window: '5h',
                remainingFraction: 0.3, // 70% used!
                resetTime: '2026-09-24T02:00:00Z'
              },
              {
                window: 'weekly',
                remainingFraction: 0.5, // 50% used!
                resetTime: '2026-09-30T00:00:00Z'
              }
            ]
          }
        ]
      }
    }

    const parsed = parseAntigravityQuotaSummary(responseWithHigh3pUsage)
    expect(parsed.session?.usedPercent).toBe(70)
    expect(parsed.weekly?.usedPercent).toBe(50)
  })

  it('handles empty or malformed data safely', () => {
    expect(parseAntigravityQuotaSummary(null)).toEqual({ session: null, weekly: null })
    expect(parseAntigravityQuotaSummary({})).toEqual({ session: null, weekly: null })
    expect(parseAntigravityQuotaSummary({ groups: [] })).toEqual({ session: null, weekly: null })
  })
})

describe('parseAntigravityUserPlan', () => {
  it('extracts plan name from user status structure', () => {
    const raw = {
      userStatus: {
        planStatus: {
          planInfo: {
            planName: 'Pro'
          }
        }
      }
    }
    expect(parseAntigravityUserPlan(raw)).toBe('Pro')
  })

  it('handles missing plan information gracefully', () => {
    expect(parseAntigravityUserPlan(null)).toBeNull()
    expect(parseAntigravityUserPlan({})).toBeNull()
  })
})

describe('probeLocalAntigravityLanguageServer', () => {
  it('only sends credentials to verified IPv4 loopback listeners owned by the target PID', async () => {
    vi.mocked(scanPlatformListeningPorts).mockResolvedValue({
      metadataAvailable: true,
      ports: [
        { host: '127.0.0.1', port: 4101, pid: 1234 },
        { host: '127.0.0.1', port: 4102, pid: 9999 },
        { host: '0.0.0.0', port: 4103 },
        { host: '192.0.2.1', port: 4104, pid: 1234 },
        { host: '::', port: 4105, pid: 1234 }
      ]
    })
    const requestJson = vi.fn().mockResolvedValue({ status: 404, body: null })
    await probeLocalAntigravityLanguageServer({
      deps: {
        findProcess: async () => ({ pid: 1234, csrfToken: 'test-only-token' }),
        requestJson
      }
    })
    expect(requestJson).toHaveBeenCalledTimes(2)
    expect(requestJson.mock.calls.every(([options]) => options.port === 4101)).toBe(true)
  })

  it('does not enumerate processes when already aborted', async () => {
    const findProcess = vi.fn()
    const controller = new AbortController()
    controller.abort()
    expect(
      await probeLocalAntigravityLanguageServer({
        signal: controller.signal,
        deps: { findProcess }
      })
    ).toBeNull()
    expect(findProcess).not.toHaveBeenCalled()
  })

  it('stops probing after cancellation instead of trying other protocols or ports', async () => {
    const controller = new AbortController()
    const requestJson = vi.fn().mockImplementation(async () => {
      controller.abort()
      throw new Error('Aborted')
    })
    expect(
      await probeLocalAntigravityLanguageServer({
        signal: controller.signal,
        deps: {
          findProcess: async () => ({ pid: 1234, csrfToken: 'test-only-token' }),
          findPorts: async () => [4101, 4102],
          requestJson
        }
      })
    ).toBeNull()
    expect(requestJson).toHaveBeenCalledTimes(1)
  })

  it('keeps an unknown plan unknown', async () => {
    const result = await probeLocalAntigravityLanguageServer({
      deps: {
        findProcess: async () => ({ pid: 1234, csrfToken: 'test-only-token' }),
        findPorts: async () => [4101],
        requestJson: async ({ path }) => ({
          status: 200,
          body: path.includes('Quota') ? sampleQuotaSummaryResponse : {}
        })
      }
    })
    expect(result?.planType).toBeNull()
  })
  it('returns null if the language server process is not found', async () => {
    const result = await probeLocalAntigravityLanguageServer({
      deps: {
        findProcess: vi.fn().mockResolvedValue(null)
      }
    })
    expect(result).toBeNull()
  })

  it('returns null if no listening ports are found', async () => {
    const result = await probeLocalAntigravityLanguageServer({
      deps: {
        findProcess: vi.fn().mockResolvedValue({ pid: 1234, csrfToken: 'test-token' }),
        findPorts: vi.fn().mockResolvedValue([])
      }
    })
    expect(result).toBeNull()
  })

  it('probes the local port and returns ok ProviderRateLimits with separated 5h and weekly', async () => {
    const requestJson = vi.fn().mockImplementation(async ({ path }: { path: string }) => {
      if (path.includes('RetrieveUserQuotaSummary')) {
        return { status: 200, body: sampleQuotaSummaryResponse }
      }
      if (path.includes('GetUserStatus')) {
        return {
          status: 200,
          body: { userStatus: { planStatus: { planInfo: { planName: 'Pro' } } } }
        }
      }
      return { status: 404, body: null }
    })

    const result = await probeLocalAntigravityLanguageServer({
      deps: {
        findProcess: vi.fn().mockResolvedValue({ pid: 1234, csrfToken: 'test-csrf-token' }),
        findPorts: vi.fn().mockResolvedValue([56498]),
        requestJson
      }
    })

    expect(result).not.toBeNull()
    expect(result?.provider).toBe('antigravity')
    expect(result?.status).toBe('ok')
    expect(result?.planType).toBe('Pro')
    expect(result?.buckets).toBeUndefined()
    expect(result?.session).toEqual({
      usedPercent: 7,
      windowMinutes: 300,
      resetsAt: new Date('2026-09-24T01:38:43Z').getTime(),
      resetDescription: null
    })
    expect(result?.weekly).toEqual({
      usedPercent: 21,
      windowMinutes: 10080,
      resetsAt: new Date('2026-09-29T23:37:07Z').getTime(),
      resetDescription: null
    })
  })
})

describe('selectAntigravityLocalServer', () => {
  const command =
    '"C:\\Program Files\\Antigravity\\bin\\language_server_windows_x64.exe" --csrf_token="test-token"'
  it('recognizes the installation executable and quoted token', () => {
    expect(selectAntigravityLocalServer([{ pid: 1234, command }])).toEqual({
      pid: 1234,
      csrfToken: 'test-token'
    })
    expect(
      selectAntigravityLocalServer([
        {
          pid: 12,
          command:
            '/home/user/.antigravity-cli/bin/language_server_linux_x64 --csrf_token=test-token'
        }
      ])
    ).toEqual({
      pid: 12,
      csrfToken: 'test-token'
    })
  })
  it('rejects unrelated or ambiguous language servers', () => {
    expect(
      selectAntigravityLocalServer([
        {
          pid: 1,
          command: '/windsurf/language_server --csrf_token=test-token --description=antigravity'
        }
      ])
    ).toBeNull()
    expect(
      selectAntigravityLocalServer([
        { pid: 1, command },
        { pid: 2, command }
      ])
    ).toBeNull()
  })
})
