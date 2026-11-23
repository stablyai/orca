import { expect, it } from 'vitest'
import {
  COPILOT_AIC_BUCKET_NAME,
  COPILOT_CHAT_BUCKET_NAME,
  COPILOT_COMPLETIONS_BUCKET_NAME
} from '../../../../shared/agent-usage/rate-limits/copilot-usage-buckets'
import { mapCopilotUsagePayload } from './copilot-usage-mapping'

const RESET = '2026-12-01'

function snapshot(
  remaining: number,
  entitlement: number,
  percentRemaining: number,
  unlimited = false
) {
  return {
    remaining,
    entitlement,
    percent_remaining: percentRemaining,
    unlimited
  }
}

it('maps the live Copilot quota shape and hides an empty premium pool', () => {
  const mapped = mapCopilotUsagePayload({
    copilot_plan: 'individual',
    access_type_sku: 'free_limited_copilot',
    quota_reset_date: RESET,
    quota_snapshots: {
      chat: snapshot(200, 200, 100),
      completions: snapshot(2000, 2000, 100),
      premium_interactions: snapshot(0, 0, 0)
    }
  })

  expect(mapped?.planType).toBe('individual')
  expect(mapped?.buckets.map((bucket) => bucket.name)).toEqual([
    COPILOT_CHAT_BUCKET_NAME,
    COPILOT_COMPLETIONS_BUCKET_NAME
  ])
  expect(mapped?.buckets[0]).toMatchObject({
    usedPercent: 0,
    windowMinutes: 43_200,
    resetsAt: Date.parse(RESET)
  })
  expect(mapped?.buckets[1]).toMatchObject({ usedPercent: 0, resetsAt: Date.parse(RESET) })
})

it('prefers an explicit plan field and percent used from percent remaining', () => {
  const mapped = mapCopilotUsagePayload({
    plan: 'business',
    copilot_plan: 'individual',
    quota_reset_date: RESET,
    quota_snapshots: {
      chat: snapshot(50, 200, 25)
    }
  })

  expect(mapped).toMatchObject({
    planType: 'business',
    buckets: [{ name: COPILOT_CHAT_BUCKET_NAME, usedPercent: 75 }]
  })
})

it('keeps a used-up premium pool and an unlimited pool with no percent', () => {
  const mapped = mapCopilotUsagePayload({
    plan: 'individual',
    quota_reset_date: RESET,
    quota_snapshots: {
      premium_interactions: {
        remaining: 0,
        entitlement: 300,
        percent_remaining: 0,
        unlimited: false
      },
      chat: { entitlement: 0, unlimited: true, quota_remaining: 0 }
    }
  })

  expect(mapped?.buckets.map((bucket) => [bucket.name, bucket.usedPercent])).toEqual([
    [COPILOT_AIC_BUCKET_NAME, 100],
    [COPILOT_CHAT_BUCKET_NAME, 0]
  ])
})

it('treats quota_remaining as remaining when the snapshot omits remaining', () => {
  const mapped = mapCopilotUsagePayload({
    quota_snapshots: {
      premium_interactions: { entitlement: 0, unlimited: false, quota_remaining: 0 },
      completions: { entitlement: 100, quota_remaining: 40 }
    }
  })

  expect(mapped?.buckets).toEqual([
    expect.objectContaining({
      name: COPILOT_COMPLETIONS_BUCKET_NAME,
      usedPercent: 60,
      resetsAt: null
    })
  ])
})

it('maps premium interactions to the AIC balance the CLI shows', () => {
  const mapped = mapCopilotUsagePayload({
    copilot_plan: 'business',
    quota_reset_date: RESET,
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
  })

  expect(mapped?.buckets.map((bucket) => [bucket.name, bucket.usedPercent])).toEqual([
    [COPILOT_AIC_BUCKET_NAME, 93.3],
    [COPILOT_CHAT_BUCKET_NAME, 0],
    [COPILOT_COMPLETIONS_BUCKET_NAME, 0]
  ])
})

it('rejects a payload that is not a quota snapshot', () => {
  expect(mapCopilotUsagePayload(null)).toBeNull()
  expect(mapCopilotUsagePayload({ message: 'Not Found' })).toBeNull()
  expect(mapCopilotUsagePayload({ quota_snapshots: [] })).toBeNull()
})
