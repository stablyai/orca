import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import { expect, it } from 'vitest'
import { fetchCopilotRateLimits, type FetchCopilotRateLimitsOptions } from './copilot-usage-fetcher'

const FIXTURE = {
  copilot_plan: 'individual',
  quota_reset_date: '2026-12-01',
  quota_snapshots: {
    chat: { remaining: 200, entitlement: 200, percent_remaining: 100, unlimited: false },
    completions: { remaining: 2000, entitlement: 2000, percent_remaining: 100, unlimited: false },
    premium_interactions: { remaining: 0, entitlement: 0, percent_remaining: 0, unlimited: false }
  }
}

function harness(outcome: ProcessResult): {
  options: FetchCopilotRateLimitsOptions
  calls: ProcessSpec[]
} {
  const calls: ProcessSpec[] = []
  return {
    calls,
    options: {
      runCommand: async (spec) => {
        calls.push(spec)
        return outcome
      },
      resolveCommand: async () => 'gh',
      resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
      resolveCwd: () => 'C:/tmp',
      now: () => 1_700_000_000_000,
      readUser: async () => null
    }
  }
}

it('reads Copilot quotas through gh api without a live call', async () => {
  const { calls, options } = harness({
    code: 0,
    signal: null,
    stdout: JSON.stringify(FIXTURE),
    stderr: '',
    timedOut: false
  })

  const result = await fetchCopilotRateLimits(options)

  expect(calls[0]).toMatchObject({
    program: 'gh',
    args: ['api', '/copilot_internal/user'],
    timeoutMs: 10_000
  })
  expect(result.status).toBe('ok')
  expect(result.planType).toBe('individual')
  expect(result.buckets?.map((bucket) => bucket.name)).toEqual(['Chat', 'Completions'])
  expect(result.session).toMatchObject({ usedPercent: 0, resetsAt: Date.parse('2026-12-01') })
  expect(result.error).toBeNull()
})

it('uses the Copilot CLI account instead of a different gh login', async () => {
  const { calls, options } = harness({
    code: 0,
    signal: null,
    stdout: JSON.stringify(FIXTURE),
    stderr: '',
    timedOut: false
  })

  const result = await fetchCopilotRateLimits({
    ...options,
    readUser: async () => ({
      payload: {
        copilot_plan: 'business',
        quota_reset_date: '2026-12-01',
        quota_snapshots: {
          premium_interactions: {
            entitlement: 6500,
            remaining: 440,
            percent_remaining: 6.7,
            unlimited: false
          },
          chat: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true },
          completions: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true }
        }
      }
    })
  })

  expect(calls).toEqual([])
  expect(result.buckets?.map((bucket) => bucket.name)).toEqual(['AIC', 'Chat', 'Completions'])
  expect(result.session).toMatchObject({ usedPercent: 93.3 })
})

it('stays unavailable when gh is missing or signed out', async () => {
  const { calls, options } = harness({
    code: 1,
    signal: null,
    stdout: '',
    stderr: 'run gh auth login',
    timedOut: false
  })
  const missing = await fetchCopilotRateLimits({
    ...options,
    resolveCommand: async () => null
  })
  expect(missing).toMatchObject({
    status: 'unavailable',
    usageMetadata: { failureKind: 'cli-unavailable' }
  })
  expect(calls).toEqual([])

  const signedOut = await fetchCopilotRateLimits(options)
  expect(signedOut).toMatchObject({
    status: 'unavailable',
    error: 'Not signed in to GitHub — run `gh auth login`',
    usageMetadata: { failureKind: 'missing-credentials' }
  })
})
